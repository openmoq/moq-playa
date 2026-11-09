import { describe, expect, it } from 'vitest';
import { PlaybackPosition } from './playback-position.js';

describe('owned playback position', () => {
  it('has no clock before admission and does not fabricate progress from elapsed time', () => {
    const clock = new PlaybackPosition(); expect(clock.read()).toBeNull();
    clock.setPlaying(true); const epoch = {}; clock.begin(epoch, 5000);
    expect(clock.read()).toBe(5000); expect(clock.read()).toBe(5000);
    expect(clock.owns(epoch)).toBe(true);
  });

  it('reads the proven output directly without needing an animation tick', () => {
    const clock = new PlaybackPosition(), epoch = {}; let position = 5000;
    clock.setPlaying(true); clock.begin(epoch, 5000);
    expect(clock.activate(epoch, () => position)).toBe(true);
    position = 5125; expect(clock.read()).toBe(5125);
    position = 6500; expect(clock.read()).toBe(6500);
  });

  it('captures pause at the latest owned output and resumes without adding paused elapsed time', () => {
    const clock = new PlaybackPosition(), epoch = {}; let position = 5000;
    clock.setPlaying(true); clock.begin(epoch, 5000); clock.activate(epoch, () => position);
    position = 5100; clock.setPlaying(false);
    position = 9000; expect(clock.read()).toBe(5100);
    clock.setPlaying(true); expect(clock.read()).toBe(9000);
  });

  it('accepts a paused seek completion while subsequent paused clock reads stay frozen', () => {
    const clock = new PlaybackPosition(), epoch = {}; let position = 4999.5;
    clock.begin(epoch, 5000);
    expect(clock.activate(epoch, () => position)).toBe(true);
    position = 6000; expect(clock.read()).toBe(4999.5);
  });

  it.each([null, NaN, Infinity, -1])('does not activate an unproven position %s', value => {
    const clock = new PlaybackPosition(), epoch = {};
    clock.setPlaying(true); clock.begin(epoch, 5000);
    expect(clock.activate(epoch, () => value)).toBe(false); expect(clock.read()).toBe(5000);
  });

  it('holds the last known value on failed or unavailable output reads', () => {
    const clock = new PlaybackPosition(), epoch = {}; let unavailable = false;
    clock.setPlaying(true); clock.begin(epoch, 5000);
    clock.activate(epoch, () => { if (unavailable) throw new Error('detached'); return 5100; });
    unavailable = true; expect(clock.read()).toBe(5100);
    expect(clock.activate(epoch, () => null)).toBe(false); expect(clock.read()).toBe(5100);
  });

  it('cannot activate or retire a superseded seek even when its old clock keeps advancing', () => {
    const clock = new PlaybackPosition(), first = {}, second = {}; let old = 5100;
    clock.setPlaying(true); clock.begin(first, 5000); clock.activate(first, () => old);
    clock.begin(second, 7000); old = 9000;
    expect(clock.activate(first, () => old)).toBe(false); clock.retire(first);
    expect(clock.read()).toBe(7000); expect(clock.owns(second)).toBe(true);
  });

  it('does not let a reentrant old-output read overwrite a newly admitted seek', () => {
    const clock = new PlaybackPosition(), first = {}, second = {}; let reenter = false;
    clock.setPlaying(true); clock.begin(first, 5000);
    clock.activate(first, () => { if (reenter) clock.begin(second, 7000); return 5500; });
    reenter = true; expect(clock.read()).toBe(7000); expect(clock.owns(second)).toBe(true);
  });

  it('refuses an activation that crosses retirement', () => {
    const clock = new PlaybackPosition(), epoch = {}; clock.begin(epoch, 5000);
    expect(clock.activate(epoch, () => { clock.retire(); return 5100; })).toBe(false);
    expect(clock.read()).toBeNull();
  });

  it('preserves a newer activation during an outer reader callback', () => {
    const clock = new PlaybackPosition(), epoch = {}; clock.setPlaying(true); clock.begin(epoch, 5000);
    expect(clock.activate(epoch, () => { expect(clock.activate(epoch, () => 7000)).toBe(true); return 5100; })).toBe(false);
    expect(clock.read()).toBe(7000);
  });

  it('keeps a newer playback intent raised during pause sampling', () => {
    const clock = new PlaybackPosition(), epoch = {}; let reenter = false, position = 5000;
    clock.setPlaying(true); clock.begin(epoch, 5000);
    clock.activate(epoch, () => { if (reenter) clock.setPlaying(true); return position; });
    reenter = true; clock.setPlaying(false); reenter = false; position = 5500;
    expect(clock.read()).toBe(5500);
  });

  it('validates a target before replacing the existing owner', () => {
    const clock = new PlaybackPosition(), first = {}; clock.begin(first, 5000);
    expect(() => clock.begin({}, NaN)).toThrow(RangeError); expect(clock.owns(first)).toBe(true);
    expect(clock.read()).toBe(5000); clock.retire(); expect(clock.read()).toBeNull();
  });
});
