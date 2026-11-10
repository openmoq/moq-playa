// Public-boundary reentry controls for the seek-live CMAF delivery trend (drafts 18/22), through the public
// MoqtPlayer and the real SDK loopback fixture (test-support/seek-live-mse). Diagnostics stay disabled (no
// media-stage observer is installed), so every evidence path exercised here is the receipt-authority path itself.
//  1. A live Object received BEFORE the live SUBSCRIBE_OK has no eligible owner: its receipt must not record then or
//     after acceptance. 1b: later accepted Objects on that alias are still delivered, assembled and recorded once the
//     SDK's scheduled pending-alias replay turn has run.
//  2. A live Object HELD by the owned output's forward hold, then pause, then released: the held assembly
//     must not record; after play resumes, fresh Objects record under a current owner (no stale seed).
//  3. Same with automatic quality switched off across the hold, then on again.
//  4. Historical FETCH + JOIN/FILL prefix never records with diagnostics disabled (explicit).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryLagDetector } from '@openmoq/playback';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, NON_SYNC_FLAGS, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, retainedHandoff, landHistory, freshLiveSubscription, acknowledgeLive, init, type Fixture } from '../test-support/seek-live-mse.js';

type LagState = { owner: { kind: string; alias: bigint; automatic: boolean; route(): boolean }; detector: DeliveryLagDetector } | null;
const lagState = (player: object) => (player as unknown as { videoDeliveryLag: LagState }).videoDeliveryLag;
const diagnosticsInstalled = (player: object) => (player as unknown as { mediaDiagnosticRuntime: unknown }).mediaDiagnosticRuntime != null;
const payloadOf = (k: number) => Uint8Array.of(80 + k, 81 + k, 82 + k, 83 + k);
const EXPECTED = [Uint8Array.of(41, 42, 43, 44), Uint8Array.of(51, 52, 53, 54), Uint8Array.of(61, 62, 63, 64), Uint8Array.of(71, 72, 73, 74)];
function continuation(from: number, count: number): Uint8Array[] {
  const encoder = new LocmafEncoder(), state = new LocmafGroupState(), context = parseLocmafTrackContext(init);
  const encode = (index: number, mdat: Uint8Array, full: boolean) => serializeLocmafObject(encoder.encode(
    buildChunk({ trackId: 1, bmdt: BigInt(4000 + index * 2000), samples: [{ duration: 2000, size: 4, flags: full ? SYNC_FLAGS : NON_SYNC_FLAGS }], mdat }), state, context, false, BigInt(index)));
  for (let i = 0; i < from; i++) encode(i, EXPECTED[i] ?? payloadOf(i), i === 0);
  return Array.from({ length: count }, (_, i) => encode(from + i, payloadOf(from + i), false));
}
async function liveOn(f: Fixture, index: number, bytes: Uint8Array) {
  const s = await f.server.openSubgroup(201n, 3n, BigInt(index), { publisherPriority: 128 });
  await f.server.sendObject(s, BigInt(index), bytes); f.publishHead({ group: 3n, object: BigInt(index) }); await f.server.closeSubgroup(s); await flush(512);
}
function completeAll(f: Fixture) { f.submissions.forEach((s, i) => { if (!s.completed) f.complete(i); }); }
/** Release the owned output's forward hold: advance native time one chunk and tick. */
async function release(f: Fixture, clock: { t: number }) { clock.t += 2; f.advance(clock.t); f.player.tick(); await flush(512); completeAll(f); await flush(512); }
async function continueLive(f: Fixture, clock: { t: number }, index: number, bytes: Uint8Array) { await release(f, clock); await liveOn(f, index, bytes); completeAll(f); await flush(512); }

describe.each([18, 22] as const)('seek-live CMAF trend public boundaries, draft %s', draft => {
  afterEach(() => vi.restoreAllMocks());

  /** Pre-ACK flow built from the fixture primitives (the fixture's own `retainedHandoff(f, true)` branch flushes only
   *  microtasks after the held SUBSCRIBE_OK and so never reaches the SDK's scheduled replay turn). */
  async function preAckHandoff(f: Fixture) {
    await landHistory(f); const sub = await freshLiveSubscription(f); f.player.play(); await flush(256);
    const response = await acknowledgeLive(f, sub, true);            // SUBSCRIBE_OK held: not yet accepted
    await f.liveObject(3);                                              // live Object on the live alias BEFORE acceptance
    response.releaseHeld(); await flush(1024);                          // accepted now
    // The SDK replays Objects parked on a not-yet-bound alias on a scheduled timer turn (beginPendingAliasReplay:
    // setTimeout(..., 0), so subscribeTrack callers install their live handler first). Microtask flushing alone
    // never reaches that turn; one real timer turn is the documented API sequencing, not a tolerance or retry.
    await new Promise(resolve => setTimeout(resolve, 0)); await flush(512);
    if (draft === 22) { const fill = await f.server.openFillStream(sub.id); await f.object(fill, 2); await f.close(fill); }
    else { const join = f.joins[0]!; const range = f.server.resolveJoiningFetch(join.id); const prefix = await f.server.openFetchStream(join.id);
      await f.object(prefix, 0); await f.object(prefix, 1); await f.object(prefix, 2); await f.close(prefix); await f.server.acceptFetch(join.id, { endLocation: range.endLocation }); }
    await flush(1024); completeAll(f); await flush(512);
    return sub;
  }

  it('a live Object received before the live SUBSCRIBE_OK never records, then or after acceptance', async () => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    try {
      f.player.setAutoQuality(true); expect(diagnosticsInstalled(f.player)).toBe(false);
      await preAckHandoff(f);
      const clock = { t: 5.125 }; await release(f, clock); await release(f, clock);
      expect(record.mock.calls.length, 'a pre-ACK receipt has no eligible owner and must not record').toBe(0);
      expect(lagState(f.player)).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('live delivery continues after a pre-ACK Object: later accepted Objects are delivered, assembled and recorded', async () => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record'); const push = vi.spyOn(CmafAssembler.prototype, 'push');
    const delivered: string[] = []; f.player.on('media_object', e => delivered.push(`${e.groupId}/${e.objectId}`));
    try {
      f.player.setAutoQuality(true); expect(diagnosticsInstalled(f.player)).toBe(false);
      const sub = await preAckHandoff(f);
      const clock = { t: 5.125 }; await release(f, clock); const pushesBefore = push.mock.calls.length;
      const extra = continuation(4, 4);
      for (let i = 0; i < extra.length; i++) await continueLive(f, clock, 4 + i, extra[i]!);
      // Premises that still hold on current source: subscription established on its alias, no errors.
      expect((f.client.session.getSubscription(sub.id) as { state?: string } | undefined)?.state).toBe('established');
      expect(f.errors).toEqual([]);
      // Required: the accepted live subscription keeps delivering after an early Object.
      expect(delivered.filter(d => d.startsWith('3/') && Number(d.split('/')[1]) >= 4), 'later live Objects delivered to the player').toHaveLength(extra.length);
      expect(push.mock.calls.length - pushesBefore, 'later live Objects assembled').toBe(extra.length);
      expect(record.mock.calls.length, 'and recorded by the trend').toBeGreaterThanOrEqual(extra.length - 1);
      expect(lagState(f.player)?.owner.kind).toBe('seek-live');
    } finally { await f.destroy(); }
  });

  it.each(['pause', 'auto-off'] as const)('a held live Object crossing %s is not recorded when released, and resuming does not seed from it', async control => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record'); const push = vi.spyOn(CmafAssembler.prototype, 'push');
    try {
      f.player.setAutoQuality(true); expect(diagnosticsInstalled(f.player)).toBe(false);
      await retainedHandoff(f, false); completeAll(f); await flush(256);
      const clock = { t: 5.125 }; const extra = continuation(4, 6);
      // Establish an eligible owner and a trend origin with two normal Objects.
      await continueLive(f, clock, 4, extra[0]!); await continueLive(f, clock, 5, extra[1]!);
      const baseline = record.mock.calls.length; expect(baseline).toBeGreaterThanOrEqual(1);
      const stateBefore = lagState(f.player); expect(stateBefore?.owner.kind).toBe('seek-live');
      // Hold: deliver Object 6 WITHOUT releasing the forward hold → captured with authority, queued, not yet assembled.
      const pushesBeforeHold = push.mock.calls.length;
      await liveOn(f, 6, extra[2]!); expect(push.mock.calls.length, 'held Object is not assembled yet').toBe(pushesBeforeHold);
      // Cross the boundary, then release the hold so the held Object assembles under a no-longer-eligible owner.
      if (control === 'pause') f.player.pause(); else f.player.setAutoQuality(false);
      await flush(128); await release(f, clock); await flush(512);
      expect(push.mock.calls.length - pushesBeforeHold, 'held Object assembled after the boundary').toBeGreaterThanOrEqual(1);
      expect(record.mock.calls.length, `no record from the held Object across ${control}`).toBe(baseline);
      // Resume: a fresh Object records again under a CURRENT owner; the detector/state is not the stale one seeded by the hold.
      if (control === 'pause') f.player.play(); else f.player.setAutoQuality(true);
      await flush(128);
      await continueLive(f, clock, 7, extra[3]!); await continueLive(f, clock, 8, extra[4]!);
      const stateAfter = lagState(f.player);
      expect(record.mock.calls.length, 'records resume after the boundary').toBeGreaterThan(baseline);
      expect(stateAfter?.owner.kind).toBe('seek-live'); expect(stateAfter?.owner.route()).toBe(true);
      expect(stateAfter?.owner.automatic).toBe(true);
      // Replacement-of-state witness: the owner object admitted before the boundary is not the one recording after it.
      expect(stateAfter?.owner, 'resumed recording uses a freshly captured owner').not.toBe(stateBefore?.owner);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('historical FETCH and JOIN/FILL prefix never record with diagnostics disabled', async () => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    try {
      f.player.setAutoQuality(true); expect(diagnosticsInstalled(f.player)).toBe(false);
      let mid = -1; await retainedHandoff(f, false, async () => { mid = record.mock.calls.length; });
      expect(mid).toBe(0); expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
