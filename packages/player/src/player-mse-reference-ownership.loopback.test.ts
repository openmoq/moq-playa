import { expect, it, vi } from 'vitest';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { audioSelectionFixture } from '../test-support/audio-selection.js';

async function fixture() {
  const made: { assembler?: CmafAssembler } = {};
  const f = await audioSelectionFixture(18, { path: 'cmaf', config: {
    createCmafAssembler: options => { const assembler = new CmafAssembler(options); made.assembler = assembler; return assembler; },
  } });
  try {
    if (!made.assembler) throw new Error('No actual MSE assembler was constructed');
    void f.player.audioTimelineReference;
    await f.sendAudio('english', 71n, 0n, 10_040_000n);
    const reference = f.player.audioTimelineReference;
    expect(reference).not.toBeNull();
    if (!reference) throw new Error('No accepted source reference');
    expect(made.assembler.capturePresentationPlacement('audio')).not.toBeNull();
    return { ...f, assembler: made.assembler, reference };
  } catch (error) { await f.destroy(); throw error; }
}

it('retires a raw reference when its absolute assembler placement changes without changing epoch', async () => {
  const f = await fixture();
  try {
    const epoch = f.assembler.getEpoch('audio');
    f.assembler.setPresentationPlacement('audio', { sourceTimeUs: 10_000_000n,
      rebasedTimeUs: { numerator: 1_000_000n, denominator: 1n } });
    expect(f.assembler.getEpoch('audio')).toBe(epoch);
    expect(f.player.audioTimelineReference).toBeNull();
    await f.sendAudio('english', 72n, 0n, 10_060_000n);
    expect(f.player.audioTimelineReference).not.toBeNull();
    expect(f.player.audioTimelineReference?.token).not.toBe(f.reference.token);
  } finally { await f.destroy(); }
});

it('retires a raw reference when the native timestamp offset changes', async () => {
  const f = await fixture();
  try {
    const epoch = f.assembler.getEpoch('audio');
    f.source.setTimestampOffset?.('audio', 0.125);
    expect(f.assembler.getEpoch('audio')).toBe(epoch);
    expect(f.player.audioTimelineReference).toBeNull();
    await f.sendAudio('english', 72n, 0n, 10_060_000n);
    expect(f.player.audioTimelineReference).not.toBeNull();
    expect(f.player.audioTimelineReference?.token).not.toBe(f.reference.token);
  } finally { await f.destroy(); }
});

it('keeps its reference token across normal accepted media progress with unchanged native placement', async () => {
  const f = await fixture();
  try {
    const context = f.assembler.capturePresentationPlacement('audio');
    await f.sendAudio('english', 72n, 0n, 10_060_000n);
    expect(f.assembler.capturePresentationPlacement('audio')?.token).toBe(context?.token);
    expect(f.player.audioTimelineReference?.token).toBe(f.reference.token);
    expect(f.player.audioTimelineReference?.observedSourceTimeUs).toBe(10_060_000n);
  } finally { await f.destroy(); }
});

it('returns unavailable when the native offset accessor destroys its reference owner', async () => {
  const f = await fixture(); let destroyed: Promise<void> | undefined;
  try {
    const get = f.source.getTimestampOffset;
    if (!get) throw new Error('Fixture has no native offset accessor');
    const read = vi.fn(get).mockImplementationOnce(role => {
      destroyed = f.player.destroy(); return get.call(f.source, role);
    });
    f.source.getTimestampOffset = read;
    try { expect(f.player.audioTimelineReference).toBeNull(); await destroyed; }
    finally { f.source.getTimestampOffset = get; }
  } finally { await f.destroy(); }
});

it('refuses a token if the offset callback changes assembler placement after its earlier placement check', async () => {
  const f = await fixture();
  try {
    const get = f.source.getTimestampOffset!;
    const read = vi.fn(get).mockImplementationOnce(role => {
      f.assembler.setPresentationPlacement('audio', { sourceTimeUs: 10_000_000n,
        rebasedTimeUs: { numerator: 1_000_000n, denominator: 1n } });
      return get.call(f.source, role);
    });
    f.source.getTimestampOffset = read;
    let observed;
    try { observed = f.player.audioTimelineReference; } finally { f.source.getTimestampOffset = get; }

    expect(f.assembler.capturePresentationPlacement('audio')).toBeNull();
    expect(observed).toBeNull();
  } finally { await f.destroy(); }
});

it('does not reinstall observation from an input retired by a note-time offset callback', async () => {
  const f = await fixture();
  try {
    f.player.play();
    f.wire.server.setLargestLocationProvider(id => {
      const name = f.wire.requests.find(request => request.id === id)?.name;
      return { group: name === 'audio-en' ? 72n : name === 'video' ? 800n : 1n, object: 0n };
    });
    f.assembler.setPresentationPlacement('audio', { sourceTimeUs: 10_000_000n,
      rebasedTimeUs: { numerator: 1_000_000n, denominator: 1n } });
    const get = f.source.getTimestampOffset!;
    let reset = false, clearedDuringReset = false;
    const read = vi.fn(get).mockImplementationOnce(role => {
      reset = true; f.player.pause(); f.player.play();
      clearedDuringReset = f.player.audioTimelineReference === null;
      return get.call(f.source, role);
    });
    f.source.getTimestampOffset = read;
    try { await f.sendAudio('english', 72n, 0n, 10_060_000n); } finally { f.source.getTimestampOffset = get; }
    expect(reset).toBe(true); expect(clearedDuringReset).toBe(true);
    const observed = f.player.audioTimelineReference;

    expect(observed).toBeNull();
  } finally { await f.destroy(); }
});
