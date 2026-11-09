import { expect, it, vi } from 'vitest';
import type { PlaybackPipeline } from '@openmoq/playback';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { fixture, sequence, headers } from '../test-support/locmaf-gap-fixture.js';

function packets(gap: boolean, independent: boolean) {
  const context = parseLocmafTrackContext(headers.video), state = new LocmafGroupState(), encoder = new LocmafEncoder();
  const decoder = new LocmafTrackDecoder(headers.video);
  const ids = gap ? [0n, 2n, 3n] : [0n, 1n, 2n];
  return ids.map((id, index) => {
    const key = index === 0 || index === 1 && independent;
    const object = encoder.encode(buildChunk({ trackId: 11,
      bmdt: 90000n + id * 3000n, samples: [{ duration: 3000, size: 6, flags: key ? SYNC_FLAGS : NON_SYNC_FLAGS }],
      mdat: Uint8Array.of(0, 0, 0, 2, key ? 0x65 : 0x41, 0x80),
    }), state, context, index === 1, id);
    expect(object.kind).toBe('moof');
    if (object.kind === 'moof') expect(object.header.full).toBe(index < 2);
    const payload = serializeLocmafObject(object);
    const decoded = decoder.push(7n, id, payload);
    // Container recovery premise independent of playback: all carriers reconstruct.
    expect(decoded.kind).toBe('chunk');
    return { id, payload, timestamp: Number((90000n + id * 3000n) * 1000000n / 90000n), key };
  });
}

it.each([
  { name: 'healthy contiguous independent full then delta', gap: false, independent: true },
  { name: 'missing Object1 with independent full Object2 then delta Object3', gap: true, independent: true },
  { name: 'control: missing Object1 with dependent full Object2 is not random access', gap: true, independent: false },
])('$name', async ({ gap, independent }) => {
  const h = await fixture(true);
  const pipeline = (h.player as unknown as { videoPipeline: PlaybackPipeline }).videoPipeline;
  const admitted = vi.spyOn(pipeline, 'pushSampleObject');
  try {
    h.player.play();
    const [audio] = sequence('audio'); await h.send('audio', 0n, audio!.payload, 7n);
    const inputs = packets(gap, independent);
    await h.send('video', 0n, inputs[0]!.payload, 7n);
    for (let i = 0; i < 10 && h.decoded.length === 0; i++) h.advance(10_000);
    expect(h.decoded, 'premise: Object0 actually reached the configured decoder').toHaveLength(1);
    expect(h.decoded[0]).toEqual({ timestamp: 1_000_000, type: 'key' });
    await h.send('video', inputs[1]!.id, inputs[1]!.payload, 7n);
    await h.send('video', inputs[2]!.id, inputs[2]!.payload, 7n);
    // Give existing gap timeout / skip machinery time to operate, not just intake.
    for (let i = 0; i < 80; i++) h.advance(25_000);
    expect(admitted.mock.calls.map(([object]) => object.objectId), 'all real wire carriers reach typed pipeline intake').toEqual(inputs.map(input => input.id));
    expect(admitted.mock.calls.map(([, samples]) => samples[0]?.chunk.type)).toEqual(inputs.map(input => input.key ? 'key' : 'delta'));
    expect(h.errors).toEqual([]);
    console.info('gap-discriminator', { gap, independent, decoded: h.decoded, floor: String(pipeline.minimumAcceptedGroupId), bufferedGroups: pipeline.bufferedGroupCount });
    if (independent) {
      expect(h.decoded.map(chunk => chunk.type), 'independent full recovery and its following delta must decode').toEqual(['key', 'key', 'delta']);
      expect(h.decoded.map(chunk => chunk.timestamp)).toEqual(inputs.map(input => Math.round(Number(90000n + input.id * 3000n) * 1000000 / 90000)));
    } else {
      expect(h.decoded, 'a full container header alone cannot restore missing codec references').toHaveLength(1);
    }
    expect(h.errors).toEqual([]);
  } finally { admitted.mockRestore(); await h.destroy(); }
});
