import { describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { buildChunk, buildInit, NON_SYNC_FLAGS, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { SeekCmafInput, type SeekCmafTimingObservation } from './seek-cmaf-input.js';

const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
function object(payload: Uint8Array, id = 0n): MoqtObject {
  return { kind: 'data', payload, trackAlias: varint(0), groupId: varint(3), objectId: varint(id),
    subgroupId: varint(0), publisherPriority: 128 };
}
function bytes(time = 4000n, flags = SYNC_FLAGS): Uint8Array {
  return buildChunk({ trackId: 1, bmdt: time, samples: [{ duration: 1000, size: 4, flags }],
    mdat: Uint8Array.of(1, 2, 3, 4) });
}
function prepare(index = 0n): SeekCmafInput {
  return new SeekCmafInput({ init, packaging: 'cmaf', role: 'video', location: { groupId: 3n, objectId: index },
    mediaPts: 4000, timestampRounding: 'floor', maxBytes: 8192, maxObjects: 16 });
}
function observation(authority: object = {}): SeekCmafTimingObservation {
  return { authority, report: vi.fn() };
}
function halves(): readonly [Uint8Array, Uint8Array] {
  const raw = bytes(), split = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0);
  return [raw.slice(0, split), raw.slice(split)];
}

describe('seek CMAF timing observation provenance', () => {
  it.each([false, true])('retains the exact complete input observation with diagnostic tokens=%s', diagnostics => {
    const input = prepare(), timing = observation(), raw = bytes();
    const result = input.push(object(raw), diagnostics ? {} : undefined, timing);
    expect(result).toHaveLength(1); expect(input.ready).toBe(true);
    expect(result[0]!.observation).toBe(timing); expect(result[0]!.bytes).toBe(raw);
    expect(result[0]!.groupId).toBe(3n); expect(result[0]!.objectId).toBe(0n);
    expect(result[0]!.inputs !== undefined).toBe(diagnostics);
    // This leaf carries authority; only the assembly consumer may report it.
    expect(timing.report).not.toHaveBeenCalled();
  });

  it.each([false, true])('same-authority live halves retain only the completing callback, diagnostics=%s', diagnostics => {
    const input = prepare(), authority = {}, first = observation(authority), second = observation(authority);
    const [moof, mdat] = halves();
    expect(input.push(object(moof), diagnostics ? {} : undefined, first)).toEqual([]);
    const result = input.push(object(mdat, 1n), diagnostics ? {} : undefined, second);
    expect(input.ready).toBe(true); expect(result).toHaveLength(1);
    expect(result[0]!.observation).toBe(second); expect(result[0]!.objectId).toBe(0n);
    expect(result[0]!.bytes).toEqual(bytes());
    expect(result[0]!.inputs?.length).toBe(diagnostics ? 2 : undefined);
    expect(first.report).not.toHaveBeenCalled(); expect(second.report).not.toHaveBeenCalled();
  });

  it.each(['history/live', 'live/history', 'unknown/live', 'live/unknown', 'changed authority'] as const)(
    'withholds %s split timing while preserving complete media', kind => {
      const input = prepare(), [moof, mdat] = halves();
      const first = kind === 'history/live' || kind === 'unknown/live' ? undefined : observation();
      const second = kind === 'live/history' || kind === 'live/unknown' ? undefined : observation();
      // Diagnostic attribution is deliberately independent of timing authority.
      const firstInput = kind.startsWith('unknown') ? undefined : {};
      const secondInput = kind.endsWith('unknown') ? undefined : {};
      expect(input.push(object(moof), firstInput, first)).toEqual([]);
      const result = input.push(object(mdat, 1n), secondInput, second);
      expect(result).toHaveLength(1); expect(input.ready).toBe(true);
      expect(result[0]!.bytes).toEqual(bytes()); expect(result[0]!.objectId).toBe(0n);
      expect(result[0]).not.toHaveProperty('observation');
      if (first) expect(first.report).not.toHaveBeenCalled();
      if (second) expect(second.report).not.toHaveBeenCalled();
    });

  it.each([false, true])('staged history does not borrow the indexed live observation, live=%s', live => {
    const input = prepare(1n), timing = live ? observation() : undefined;
    expect(input.push(object(bytes(3000n)))).toEqual([]);
    const result = input.push(object(bytes(4000n, NON_SYNC_FLAGS), 1n), undefined, timing);
    expect(result.map(item => item.objectId)).toEqual([0n, 1n]);
    expect(result[0]).not.toHaveProperty('observation');
    expect(result[1]!.observation).toBe(timing);
    if (live) expect(result[1]).toHaveProperty('observation');
    else expect(result[1]).not.toHaveProperty('observation');
  });

  it('releasing multiple staged inputs preserves each distinct observation', () => {
    const input = prepare(1n), first = observation(), second = observation();
    expect(input.push(object(bytes(3000n)), undefined, first)).toEqual([]);
    const result = input.push(object(bytes(4000n, NON_SYNC_FLAGS), 1n), undefined, second);
    expect(result).toHaveLength(2);
    expect(result[0]!.observation).toBe(first); expect(result[1]!.observation).toBe(second);
    expect(result.every(item => item.inputs === undefined)).toBe(true);
  });

  it('one Object with successive moof/mdat pairs owns one observation and unchanged bytes', () => {
    const first = bytes(), second = bytes(5000n, NON_SYNC_FLAGS), combined = new Uint8Array(first.length + second.length);
    combined.set(first); combined.set(second, first.length);
    const input = prepare(), timing = observation();
    const result = input.push(object(combined), undefined, timing);
    expect(result).toHaveLength(1); expect(input.ready).toBe(true);
    expect(result[0]!.bytes).toBe(combined); expect(result[0]!.observation).toBe(timing);
    expect(timing.report).not.toHaveBeenCalled();
  });

  it('a subsequent unobserved chunk cannot reuse the preceding observation', () => {
    const input = prepare(), timing = observation();
    const first = input.push(object(bytes()), undefined, timing);
    const second = input.push(object(bytes(5000n, NON_SYNC_FLAGS), 1n));
    expect(first[0]!.observation).toBe(timing); expect(second).toHaveLength(1);
    expect(second[0]).not.toHaveProperty('observation'); expect(second[0]!.objectId).toBe(1n);
  });

  it('initialization cannot lend timing authority to following unobserved media', () => {
    const input = prepare(), timing = observation();
    expect(input.push(object(init), undefined, timing)).toEqual([]);
    const result = input.push(object(bytes()));
    expect(result).toHaveLength(1); expect(result[0]).not.toHaveProperty('observation');
    expect(timing.report).not.toHaveBeenCalled();
  });
});
