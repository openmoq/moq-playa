// Accepted live input feeds the delivery trend; historical retrieval and stale owners do not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryLagDetector } from '@openmoq/playback';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { buildChunk, NON_SYNC_FLAGS, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, retainedHandoff, init, payloads, type Fixture } from '../test-support/seek-live-mse.js';

type LagState = { owner: { kind: string; alias: bigint; source: unknown; assembler: unknown; automatic: boolean; route(): boolean } } | null;
const lagState = (player: object) => (player as unknown as { videoDeliveryLag: LagState }).videoDeliveryLag;
const payloadOf = (k: number) => Uint8Array.of(80 + k, 81 + k, 82 + k, 83 + k);

/** Continuation Objects `from`.. on the same track as deltas of ONE encoder state that replayed the fixture's own
 *  Objects 0..3 (same init, chunk geometry and flags), so the LOCMAF delta headers continue the stream the player saw. */
function continuation(from: number, count: number): Uint8Array[] {
  const encoder = new LocmafEncoder(), state = new LocmafGroupState(), context = parseLocmafTrackContext(init);
  const expected = [Uint8Array.of(41, 42, 43, 44), Uint8Array.of(51, 52, 53, 54), Uint8Array.of(61, 62, 63, 64), Uint8Array.of(71, 72, 73, 74)];
  const encode = (index: number, mdat: Uint8Array, full: boolean) => serializeLocmafObject(encoder.encode(
    buildChunk({ trackId: 1, bmdt: BigInt(4000 + index * 2000), samples: [{ duration: 2000, size: 4, flags: full ? SYNC_FLAGS : NON_SYNC_FLAGS }], mdat }), state, context, false, BigInt(index)));
  for (let i = 0; i < from; i++) encode(i, expected[i] ?? payloadOf(i), i === 0); // replay to reach the same state
  return Array.from({ length: count }, (_, i) => encode(from + i, payloadOf(from + i), false));
}
async function liveOn(f: Fixture, alias: bigint, index: number, bytes: Uint8Array) {
  const s = await f.server.openSubgroup(alias, 3n, BigInt(index), { publisherPriority: 128 });
  await f.server.sendObject(s, BigInt(index), bytes); f.publishHead({ group: 3n, object: BigInt(index) }); await f.server.closeSubgroup(s); await flush(512);
}
/** The owned seek output holds forward input while native playback is far ahead: advance native time 2 s
 *  (one chunk) and tick before each continuing live Object, then complete the resulting native submission. */
async function continueLive(f: Fixture, clock: { t: number }, index: number, bytes: Uint8Array) {
  clock.t += 2; f.advance(clock.t); f.player.tick(); await flush(512);
  await liveOn(f, 201n, index, bytes); completeAll(f); await flush(512);
}
/** Complete every pending native submission (forward input credit for the owned seek output; NOT what proves placement). */
function completeAll(f: Fixture) { f.submissions.forEach((s, i) => { if (!s.completed) f.complete(i); }); }

describe.each([18, 22] as const)('CMAF delivery trend ownership across live routes, draft %s', draft => {
  afterEach(() => vi.restoreAllMocks());

  it('ordinary accepted live output: receipts are requested, decode receipts carry a proven placement token, and the trend records under the ordinary owner', async () => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    const push = vi.spyOn(CmafAssembler.prototype, 'push');
    try {
      f.player.setAutoQuality(true); f.player.play(); await flush(256);
      for (let i = 0; i < payloads.length; i++) { await liveOn(f, 200n, i, payloads[i]!); completeAll(f); await flush(256); }
      const timed = push.mock.calls.filter(call => call[5] === true);
      expect(timed.length, 'ordinary route requests source-timing receipts').toBe(payloads.length);
      const decode = push.mock.results.map(r => r.value).filter((v): v is { state: 'emitted'; sourceDecodeTime?: object } => !!v && (v as { state: string }).state === 'emitted' && 'sourceDecodeTime' in v);
      expect(decode.length, 'decode receipts after the placement is proven').toBeGreaterThanOrEqual(payloads.length - 1);
      expect(record.mock.calls.length).toBeGreaterThanOrEqual(payloads.length - 1);
      expect(lagState(f.player)?.owner.kind).toBe('ordinary');
      expect(lagState(f.player)?.owner.alias).toBe(200n);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('historical FETCH and the JOIN/FILL prefix never record (fetched/backfill deliveries are not owners)', async () => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    try {
      f.player.setAutoQuality(true);
      let beforePrefixComplete = -1;
      await retainedHandoff(f, false, async () => { beforePrefixComplete = record.mock.calls.length; });
      expect(beforePrefixComplete, 'no record from FETCH history or the JOIN/FILL prefix').toBe(0);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('accepted seek-live video output: with the placement proven by assembler emission, continuing live Objects request receipts and the trend records under the seek-live owner', async () => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    const push = vi.spyOn(CmafAssembler.prototype, 'push');
    try {
      f.player.setAutoQuality(true);
      await retainedHandoff(f, false); completeAll(f); await flush(256);
      // Premises: one retained native resource, current, forward credit granted; placement proven by the live assembler's own emission.
      expect(f.resources).toHaveLength(1); expect(f.resources[0]!.current).toBe(true); expect(f.nativeBytes.length).toBeGreaterThanOrEqual(4);
      const assembler = push.mock.instances.at(-1) as CmafAssembler | undefined; expect(assembler).toBeDefined();
      expect(assembler!.capturePresentationPlacement('video'), 'placement proven by assembler emission').not.toBeNull();
      const owner = (f.player as unknown as { captureVideoMeasurementOwner(): { kind: string; source: unknown; assembler: unknown; automatic: boolean; route(): boolean } | null }).captureVideoMeasurementOwner();
      expect(owner?.kind).toBe('seek-live'); expect(owner?.automatic).toBe(true); expect(owner?.route()).toBe(true);
      const before = record.mock.calls.length, pushesBefore = push.mock.calls.length, nativeBefore = f.nativeBytes.length;
      const extra = continuation(4, 4), clock = { t: 5.125 };
      for (let i = 0; i < extra.length; i++) await continueLive(f, clock, 4 + i, extra[i]!);
      const livePushes = push.mock.calls.slice(pushesBefore);
      // Premises demonstrated: every continuing Object reached the live assembler and was appended natively.
      expect(livePushes.length).toBe(extra.length);
      expect(f.nativeBytes.length - nativeBefore, 'continuing live media really appended').toBe(extra.length);
      // Live output contributes to the same bounded trend after assembly.
      expect(livePushes.filter(c => c[5] === true).length, 'seek-live live Objects must request source-timing receipts').toBeGreaterThanOrEqual(extra.length - 1);
      expect(record.mock.calls.length - before, 'trend records from the accepted seek-live output').toBeGreaterThanOrEqual(extra.length - 1);
      expect(lagState(f.player)?.owner.kind).toBe('seek-live');
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('a paused owner and a non-automatic owner never record from late live Objects (stale ownership negatives)', async () => {
    const f = await fixture(draft, true);
    const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
    try {
      f.player.setAutoQuality(true);
      await retainedHandoff(f, false); completeAll(f); await flush(256);
      const push = vi.spyOn(CmafAssembler.prototype, 'push');
      const before = record.mock.calls.length, extra = continuation(4, 4), clock = { t: 5.125 }; let p0 = push.mock.calls.length;
      f.player.pause(); await flush(128);                                   // route() false: not PLAYING
      for (let i = 0; i < 2; i++) await continueLive(f, clock, 4 + i, extra[i]!);
      expect(record.mock.calls.length - before, 'paused owner must not record').toBe(0);
      f.player.play(); f.player.setAutoQuality(false); await flush(128); p0 = push.mock.calls.length; // automatic false: not admitted
      for (let i = 2; i < 4; i++) await continueLive(f, clock, 4 + i, extra[i]!);
      expect(push.mock.calls.length - p0, 'non-automatic Objects still assembled (premise)').toBe(2);
      expect(record.mock.calls.length - before, 'non-automatic owner must not record').toBe(0);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
