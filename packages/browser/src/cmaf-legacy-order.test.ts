import { expect, it } from 'vitest';
import { CmafAssembler } from './cmaf-assembler.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';

const init = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
function chunk(at: number, marker: number) {
  return buildChunk({ trackId: 1, bmdt: BigInt(at),
    samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(marker, 2, 3, 4) });
}
function split(bytes: Uint8Array): [Uint8Array, Uint8Array] {
  const end = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  return [bytes.subarray(0, end), bytes.subarray(end)];
}
function fixture() {
  const output: Array<{ bytes: Uint8Array; inputs: readonly (object | undefined)[] | undefined }> = [];
  const discarded: Array<{ input: object; reason: string }> = [];
  const assembler = new CmafAssembler({
    onSegment: (_role, bytes, _name, _group, inputs) => { output.push({ bytes, inputs }); },
    onDiscard: (input, reason) => { discarded.push({ input, reason }); },
  });
  assembler.setInitSegment('video', init);
  const push = (id: bigint, bytes: Uint8Array, input?: object, group = 1n, sourceKey = 'source') =>
    assembler.push('video', 'video', group, bytes, input, undefined, sourceKey, id);
  return { assembler, output, discarded, push };
}

it('keeps a newer pending legacy moof when an earlier immutable pair is replayed', () => {
  const f = fixture();
  const [moofA, mdatA] = split(chunk(1000, 1));
  const [moofB, mdatB] = split(chunk(2000, 2));
  const first = {}, second = {}, lateMoof = {}, lateMdat = {};
  f.push(0n, moofA); f.push(1n, mdatA);
  f.push(2n, moofB, first);
  f.push(0n, moofA, lateMoof); f.push(1n, mdatA, lateMdat);
  f.push(3n, mdatB, second);
  expect(f.output.map(event => split(event.bytes)[1])).toEqual([mdatA, mdatB]);
  expect(f.output[1]!.inputs?.[0]).toBe(first);
  expect(f.output[1]!.inputs?.[1]).toBe(second);
  expect(f.discarded).toEqual([lateMoof, lateMdat].map(input => ({ input, reason: 'out of order legacy object' })));
});

it('retains the original pending token when the same legacy moof is repeated', () => {
  const f = fixture(), [moof, mdat] = split(chunk(1000, 1));
  const original = {}, repeated = {}, tail = {};
  f.push(2n, moof, original); f.push(2n, moof, repeated); f.push(3n, mdat, tail);
  expect(f.output).toHaveLength(1);
  expect(f.output[0]!.inputs?.[0]).toBe(original);
  expect(f.output[0]!.inputs?.[1]).toBe(tail);
  expect(f.discarded).toEqual([{ input: repeated, reason: 'out of order legacy object' }]);
});

it('keeps complete reordered and sparse CMAF objects independent of a pending legacy pair', () => {
  const f = fixture(), [moof, mdat] = split(chunk(4000, 1));
  const complete = [chunk(2000, 2), chunk(3000, 3)];
  f.push(10n, moof);
  f.push(1000n, complete[0]!); f.push(0n, complete[1]!);
  f.push(11n, mdat);
  expect(f.output.map(event => split(event.bytes)[1])).toEqual([...complete.map(bytes => split(bytes)[1]), mdat]);
  expect(f.discarded).toEqual([]);
});

it('keeps pending order separate by source and group, and clears it with the pending pair', () => {
  const f = fixture(), [moof, mdat] = split(chunk(1000, 1));
  f.push(10n, moof, undefined, 1n, 'a');
  f.push(0n, moof, undefined, 2n, 'a');
  f.push(0n, moof, undefined, 1n, 'b');
  f.push(1n, mdat, undefined, 2n, 'a');
  f.push(1n, mdat, undefined, 1n, 'b');
  f.push(11n, mdat, undefined, 1n, 'a');
  expect(f.output).toHaveLength(3);
  f.push(20n, moof);
  f.assembler.clearPending('video');
  f.push(0n, moof); f.push(1n, mdat);
  expect(f.output).toHaveLength(4);
});
