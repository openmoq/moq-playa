import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { locSeekFixture } from '../test-support/loc-seek.js';
import { createMediaDiagnostics } from './media-diagnostics.js';

type Fixture = Awaited<ReturnType<typeof locSeekFixture>>;
type Callback = 'stall' | 'decode-error' | 'stall-recovered';
const callbacks: Callback[] = ['stall', 'decode-error', 'stall-recovered'];

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function object(f: Fixture, timestamp: bigint, independent: boolean) {
  return { payload: Uint8Array.of(0, 0, 0, 2, independent ? 0x65 : 0x41, 0x88),
    extensions: encodeLocHeaders({ timestamp, timescale: 1000n,
      videoFrameMarking: { independent, startOfFrame: true, endOfFrame: true,
        discardable: false, baseLayerSync: false, temporalId: 0 } },
    { wireProfile: locWireProfileForDraft(f.draft), locVersion: 4 }) };
}
function retained(f: Fixture, kind: Callback) {
  const callback = kind === 'stall' ? f.renderer.onStall
    : kind === 'stall-recovered' ? f.renderer.onStallRecovered : f.decoder.onError;
  expect(callback, 'the actual ordinary dispatcher must install this adapter callback').toBeTypeOf('function');
  return () => {
    if (kind === 'decode-error') f.decoder.onError?.(new Error('displaced decoder failure'));
    else if (kind === 'stall') f.renderer.onStall?.(731);
    else f.renderer.onStallRecovered?.(731);
  };
}
function counters(f: Fixture) {
  const stats = f.player.stats;
  return { stalls: stats.stallCount, recovered: stats.totalStallDurationMs,
    errors: stats.decodeErrorCount, recoveries: stats.recoveryActionCount };
}
async function completeSeek(f: Fixture) {
  await f.player.seek(2000); await flush(128);
  expect(f.fetchIds).toHaveLength(1);
  const id = f.fetchIds[0]!;
  await f.server.acceptFetch(id, { endOfTrack: 0, endLocation: { group: 4n, object: 0n } });
  const stream = await f.server.openFetchStream(id);
  try {
    for (const [index, timestamp] of [1000n, 2500n, 2100n, 2600n].entries()) {
      await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: BigInt(index),
        publisherPriority: 128, ...object(f, timestamp, index === 0) });
      await flush(128);
    }
    await f.server.sendFetchObject(stream, { groupId: 4n, subgroupId: 0n, objectId: 0n,
      publisherPriority: 128, ...object(f, 3000n, true) });
  } finally { await f.server.closeFetchStream(stream); }
  await flush(512);
}

describe('ordinary LOC callbacks while adopting historical output', () => {
  it.each(callbacks)('ignores displaced %s during the old buffered-input discard', async kind => {
    const f = await locSeekFixture(22, false, true, { producingOutput: true, reorderVideoOutput: true });
    const fire = retained(f, kind), stall = vi.fn(), recovered = vi.fn(), recovery = vi.fn();
    f.player.on('stall', stall); f.player.on('stall_recovered', recovered); f.player.on('recovery_action', recovery);
    let fired = 0, adoptedAtDiscard = false, nativeResetsAtDiscard = -1;
    const before = counters(f);
    const off = f.player.observeMediaStages(event => {
      if (fired || event.stage !== 'discarded' || event.reason !== 'decoder reset') return;
      // This is the real old pipeline's buffered input terminal, not a direct
      // invocation of an engine callback or a private owner-state mutation.
      fired++;
      adoptedAtDiscard = f.outputs.length === 1 && f.outputs[0]!.frames.length === 4;
      nativeResetsAtDiscard = vi.mocked(f.outputs[0]!.decoder.reset).mock.calls.length;
      fire();
    }, { createTracker: createMediaDiagnostics });
    let oldStream: bigint | undefined;
    try {
      oldStream = await f.server.openSubgroup(200n, 10n, 0n, { publisherPriority: 128, hasExtensions: true });
      const delta = object(f, 10_020n, false);
      await f.server.sendObject(oldStream, 1n, delta.payload, delta.extensions); await flush(128);
      expect(f.decoder.decode, 'the old object waits for Object 0 and remains buffered').not.toHaveBeenCalled();
      await completeSeek(f);
      expect(fired, 'adoption must report the buffered ordinary input exactly once').toBe(1);
      expect(adoptedAtDiscard, 'the replacement must already have real decoded output at reentry').toBe(true);
      expect.soft(counters(f), 'displaced output cannot change current statistics').toEqual(before);
      expect(stall).not.toHaveBeenCalled(); expect(recovered).not.toHaveBeenCalled(); expect(recovery).not.toHaveBeenCalled();
      expect.soft(f.errors).toEqual([]); expect.soft(f.seeked).toHaveBeenCalledOnce();
      expect.soft(f.player.state).toBe('playing'); expect.soft(f.player.playbackPositionMs).toBe(2100);
      const output = f.outputs[0]!;
      expect.soft(output.draw).toHaveBeenCalledOnce();
      expect.soft(output.draw.mock.calls[0]?.[0]?.timestamp).toBe(2_100_000);
      expect.soft(output.decoder.reset, 'displaced callbacks must not reset adopted native decode/output').toHaveBeenCalledTimes(nativeResetsAtDiscard);
    } finally {
      off(); if (oldStream !== undefined) await f.server.closeSubgroup(oldStream);
      await f.destroy();
    }
  });

  it.each(callbacks)('keeps current %s authoritative', async kind => {
    const f = await locSeekFixture(22);
    try {
      const fire = retained(f, kind), before = counters(f);
      const stall = vi.fn(), recovered = vi.fn();
      f.player.on('stall', stall); f.player.on('stall_recovered', recovered);
      fire();
      const after = counters(f);
      if (kind === 'stall') { expect(after.stalls).toBe(before.stalls + 1); expect(stall).toHaveBeenCalledOnce(); }
      else if (kind === 'stall-recovered') { expect(after.recovered).toBe(before.recovered + 731); expect(recovered).toHaveBeenCalledOnce(); }
      else { expect(after.errors).toBe(before.errors + 1); expect(f.errors).toContain('displaced decoder failure'); }
      expect(f.player.state).toBe('playing'); expect(f.outputs).toHaveLength(0);
    } finally { await f.destroy(); }
  });
});
