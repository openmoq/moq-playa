import { describe, expect, it, vi } from 'vitest';
import { CmafAssembler } from './cmaf-assembler.js';
import { buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
const chunk = () => buildChunk({ bmdt: 100, samples: [{ duration: 3000, size: 1, flags: SYNC_FLAGS }] });
function halves() { const bytes = chunk(); const size = new DataView(bytes.buffer).getUint32(0); return [bytes.slice(0, size), bytes.slice(size)] as const; }

describe('CMAF reconstruction provenance', () => {
  it('carries a combined Object identity without changing its media or the unobserved callback arity', () => {
    const onSegment = vi.fn(), assembler = new CmafAssembler({ onSegment }), input = {};
    assembler.push('video', 'v', 1n, chunk(), input);
    expect(onSegment.mock.calls[0]![4]).toEqual([input]);
    const plain = vi.fn(), control = new CmafAssembler({ onSegment: plain });
    control.push('video', 'v', 1n, chunk());
    expect(plain.mock.calls[0]).toHaveLength(4);
    expect(onSegment.mock.calls[0]![1]).toEqual(plain.mock.calls[0]![1]);
  });
  it('joins the actual moof and mdat input identities on the one reconstructed unit', () => {
    const onSegment = vi.fn(), assembler = new CmafAssembler({ onSegment }), a = {}, b = {};
    const [moof, mdat] = halves(); assembler.push('video', 'v', 1n, moof, a);
    expect(onSegment).not.toHaveBeenCalled(); assembler.push('video', 'v', 1n, mdat, b);
    expect(onSegment.mock.calls[0]![4]).toEqual([a, b]);
  });
  it('does not invent an identity for a half-pair received before observation', () => {
    const onSegment = vi.fn(), assembler = new CmafAssembler({ onSegment }), b = {};
    const [moof, mdat] = halves(); assembler.push('video', 'v', 1n, moof);
    assembler.push('video', 'v', 1n, mdat, b);
    expect(onSegment.mock.calls[0]![4]).toEqual([undefined, b]);
  });
  it('resolves an overwritten pending moof instead of silently losing its identity', () => {
    const onDiscard = vi.fn(), assembler = new CmafAssembler({ onSegment: vi.fn(), onDiscard }), a = {}, b = {};
    const [moof] = halves(); assembler.push('video', 'v', 1n, moof, a); assembler.push('video', 'v', 1n, moof, b);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith(a, 'superseded pending moof');
    assembler.clearPending('video'); expect(onDiscard.mock.calls[1]).toEqual([b, 'decoder reset']);
  });
  it.each(['reset', 'destroy'] as const)('resolves pending identities on %s before observer reentry', method => {
    const onSegment = vi.fn(), input = {}, replacement = {}; let reentered = false;
    const assembler = new CmafAssembler({ onSegment, onDiscard: () => {
      if (!reentered) { reentered = true; assembler.push('video', 'v', 2n, halves()[0], replacement); }
    } });
    assembler.push('video', 'v', 1n, halves()[0], input); assembler[method]();
    assembler.push('video', 'v', 2n, halves()[1], {});
    expect(onSegment.mock.calls[0]![4]?.[0]).toBe(replacement);
  });
  it('reports orphan, invalid and superseded-track drops without emitting reconstructed media', () => {
    const onDiscard = vi.fn(), onSegment = vi.fn(), assembler = new CmafAssembler({ onSegment, onDiscard });
    const orphan = {}, invalid = {}, old = {};
    assembler.push('video', 'v', 1n, halves()[1], orphan);
    assembler.push('video', 'v', 1n, new Uint8Array(1), invalid);
    assembler.selectTrack('video', 'new'); assembler.push('video', 'v', 1n, chunk(), old);
    expect(onDiscard.mock.calls).toEqual([[orphan, 'orphaned media'], [invalid, 'invalid media'], [old, 'track superseded']]);
    expect(onSegment).not.toHaveBeenCalled();
  });
});
