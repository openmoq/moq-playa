import { describe, expect, it, vi } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import { varint } from '@openmoq/transport';
function fixture(mediaType: 'video' | 'audio' = 'audio', maxBufferDepth = 100) {
  let nowUs = 1_000_000;
  const clock = { now: () => nowUs }, commands: Array<{ type: string; inputToken?: object }> = [];
  const pipeline = new PlaybackPipeline({ mediaType, clock,
    config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth },
    sync: new SyncController({ clock, driftThresholdUs: 500_000 }),
    onCommand: command => { commands.push(command); }, onEvent: () => {} });
  pipeline.configure(Uint8Array.of(1)); pipeline.inputObserver = () => {};
  const obj = (id: number, group = 0, priority = 128) => ({ kind: 'data' as const, trackAlias: varint(1), groupId: varint(group), subgroupId: varint(group),
    objectId: varint(id), publisherPriority: priority, payload: Uint8Array.of(1), extensions: undefined });
  return { pipeline, commands, obj, advance: () => { nowUs += 300_000; } };
}
describe('LOC input identity carried by the admitted pipeline entry', () => {
  it('carries the accepted input identity with the decode command', () => {
    const f = fixture(), token = {};
    f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, token); f.pipeline.tick();
    expect(f.commands.find(command => command.type === 'decode_audio')?.inputToken).toBe(token);
  });
  it('does not let a duplicate overwrite the admitted input identity', () => {
    const f = fixture(), accepted = {}, duplicate = {}, discarded = vi.fn();
    f.pipeline.inputObserver = discarded;
    const object = f.obj(0);
    f.pipeline.pushObject(object, { captureTimestamp: 1_000_000n }, accepted);
    f.pipeline.pushObject(object, { captureTimestamp: 1_000_000n }, duplicate); f.pipeline.tick();
    expect(f.commands.find(command => command.type === 'decode_audio')?.inputToken).toBe(accepted);
    expect(discarded).toHaveBeenCalledExactlyOnceWith(duplicate, 'treated as a replay');
  });
  it('releases the input identity when reset discards its buffer entry', () => {
    const f = fixture(), token = {}, discarded = vi.fn(); f.pipeline.inputObserver = discarded;
    f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, token); f.pipeline.reset();
    expect(discarded).toHaveBeenCalledExactlyOnceWith(token, 'decoder reset');
  });
  it('does not put a token on commands when observation was absent', () => {
    const f = fixture(); f.pipeline.inputObserver = undefined; f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, {}); f.pipeline.tick();
    const command = f.commands.find(command => command.type === 'decode_audio');
    expect(command).toBeDefined(); expect(command).not.toHaveProperty('inputToken');
  });
});

it('does not let an observer reassignment inherit buffered input identities', () => {
  const f = fixture(), observer = vi.fn(); f.pipeline.inputObserver = observer;
  f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, {});
  f.pipeline.inputObserver = undefined; f.pipeline.inputObserver = observer; f.pipeline.tick();
  expect(f.commands.find(command => command.type === 'decode_audio')).not.toHaveProperty('inputToken');
  expect(observer).not.toHaveBeenCalled();
});
it('finishes reset state before a discard observer admits a replacement entry', () => {
  const f = fixture(), old = {}, fresh = {}, observer = vi.fn((input: object) => {
    if (input === old) f.pipeline.pushObject(f.obj(0, 1), { captureTimestamp: 1_000_000n }, fresh);
  });
  f.pipeline.inputObserver = observer; f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, old);
  f.pipeline.reset(); f.pipeline.tick();
  expect(observer).toHaveBeenCalledExactlyOnceWith(old, 'decoder reset');
  expect(f.commands.find(command => command.type === 'decode_audio')?.inputToken).toBe(fresh);
});
it('stops a reset batch when its observer replaces the observation lifetime', () => {
  const f = fixture(), next = vi.fn(), first = vi.fn(() => { f.pipeline.inputObserver = undefined; f.pipeline.inputObserver = next; });
  f.pipeline.inputObserver = first;
  f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, {});
  f.pipeline.pushObject(f.obj(1), { captureTimestamp: 1_020_000n }, {});
  f.pipeline.reset(); expect(first).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled();
});
it('retires only the evicted input and retains the replacement identity', () => {
  const f = fixture('audio', 1), old = {}, fresh = {}, observer = vi.fn(); f.pipeline.inputObserver = observer;
  f.pipeline.pushObject(f.obj(0, 0, 200), { captureTimestamp: 1_000_000n }, old);
  f.pipeline.pushObject(f.obj(0, 1, 100), { captureTimestamp: 1_020_000n }, fresh); f.pipeline.tick();
  expect(observer).toHaveBeenCalledExactlyOnceWith(old, 'buffer eviction');
  expect(f.commands.find(command => command.type === 'decode_audio')?.inputToken).toBe(fresh);
});
it('reports a refused lower-priority input without displacing accepted ownership', () => {
  const f = fixture('audio', 1), old = {}, refused = {}, observer = vi.fn(); f.pipeline.inputObserver = observer;
  f.pipeline.pushObject(f.obj(0, 0, 100), { captureTimestamp: 1_000_000n }, old);
  f.pipeline.pushObject(f.obj(0, 1, 200), { captureTimestamp: 1_020_000n }, refused); f.pipeline.tick();
  expect(observer).toHaveBeenCalledExactlyOnceWith(refused, 'buffer full');
  expect(f.commands.find(command => command.type === 'decode_audio')?.inputToken).toBe(old);
});
it('contains discard-listener rejection while preserving the original admitted command', async () => {
  const f = fixture(), input = {}; f.pipeline.inputObserver = async () => { throw Error('observer'); };
  f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, input);
  f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, {}); f.pipeline.tick();
  await Promise.resolve(); expect(f.commands.find(command => command.type === 'decode_audio')?.inputToken).toBe(input);
});

it('removes admission metadata when a waiting startup Object is evicted so a later valid copy is not suppressed', () => {
  const f = fixture('video', 1), rejected = {}, replayed = {}, observer = vi.fn(); f.pipeline.inputObserver = observer;
  f.pipeline.pushObject(f.obj(1, 0, 200), { captureTimestamp: 1_020_000n }, rejected); f.pipeline.tick();
  expect(observer).not.toHaveBeenCalled();
  f.pipeline.pushObject(f.obj(0, 0, 10), { captureTimestamp: 1_000_000n }, {});
  expect(observer).toHaveBeenCalledExactlyOnceWith(rejected, 'buffer eviction'); f.pipeline.tick();
  f.pipeline.pushObject(f.obj(1), { captureTimestamp: 1_020_000n }, replayed); f.pipeline.tick();
  const decoded = f.commands.filter(command => command.type === 'decode_video');
  expect(decoded).toHaveLength(2); expect(decoded[1]?.inputToken).toBe(replayed);
});

it('does not retain stale header admission after evicting a waiting startup Object without diagnostics', () => {
  const f = fixture('video', 1); f.pipeline.inputObserver = undefined;
  f.pipeline.pushObject(f.obj(1, 0, 200), { captureTimestamp: 1_020_000n }); f.pipeline.tick();
  f.pipeline.pushObject(f.obj(0, 0, 10), { captureTimestamp: 1_000_000n }); f.pipeline.tick();
  f.pipeline.pushObject(f.obj(1), { captureTimestamp: 1_020_000n }); f.pipeline.tick();
  expect(f.commands.filter(command => command.type === 'decode_video')).toHaveLength(2);
});
it('does not overwrite a reset performed inside an input-discard callback', () => {
  const f = fixture(), late = {};
  f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, {}); f.pipeline.tick();
  const observer = vi.fn((input: object) => { if (input === late) f.pipeline.reset(); });
  f.pipeline.inputObserver = observer; f.pipeline.pushObject(f.obj(1), { captureTimestamp: 0n }, late); f.pipeline.tick();
  expect(observer).toHaveBeenCalledExactlyOnceWith(late, 'late frame');
  expect(f.pipeline.currentGroupId).toBe(-1n);
});

it('reports the actual buffered suffix discarded for a missing video dependency', () => {
  const f = fixture('video'), missingSuffix = {}, observer = vi.fn(); f.pipeline.inputObserver = observer;
  f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, {});
  f.pipeline.pushObject(f.obj(2), { captureTimestamp: 1_040_000n }, missingSuffix); f.pipeline.tick();
  expect(observer).not.toHaveBeenCalled(); f.advance(); f.pipeline.tick();
  expect(observer).toHaveBeenCalledExactlyOnceWith(missingSuffix, 'skipped');
  expect(f.commands.filter(command => command.type === 'decode_video')).toHaveLength(1);
});
it('reports only the inputs actually shed by the live backlog policy', () => {
  const f = fixture('video'), oldest = {}, observer = vi.fn(); f.pipeline.inputObserver = observer;
  for (let group = 0; group < 4; group++) f.pipeline.pushObject(f.obj(0, group),
    { captureTimestamp: 1_000_000n + BigInt(group * 20_000) }, group === 0 ? oldest : {});
  f.pipeline.tick(); expect(observer).toHaveBeenCalledExactlyOnceWith(oldest, 'backlog shed');
});
it('terminates buffered ownership on a track switch without transferring it to the successor', () => {
  const f = fixture(), input = {}, observer = vi.fn(); f.pipeline.inputObserver = observer;
  f.pipeline.pushObject(f.obj(0), { captureTimestamp: 1_000_000n }, input); f.pipeline.resetForTrackSwitch(1n);
  expect(observer).toHaveBeenCalledExactlyOnceWith(input, 'track superseded');
  f.pipeline.pushObject(f.obj(0, 1), { captureTimestamp: 1_020_000n }); f.pipeline.tick();
  expect(f.commands.find(command => command.type === 'decode_audio')).not.toHaveProperty('inputToken');
});

it('bounds input associations without evicting ownership or changing media admission', () => {
  const f = fixture('audio', 1025), first = {}, observer = vi.fn(); f.pipeline.inputObserver = observer;
  for (let object = 0; object < 1025; object++) f.pipeline.pushObject(f.obj(object),
    { captureTimestamp: 1_000_000n + BigInt(object * 1000) }, object === 0 ? first : {});
  expect(f.pipeline.inputEvidenceLossCount).toBe(1); f.pipeline.tick();
  const decoded = f.commands.filter(command => command.type === 'decode_audio');
  expect(decoded).toHaveLength(1025); expect(decoded[0]!.inputToken).toBe(first);
  expect(decoded[1024]).not.toHaveProperty('inputToken');
  f.pipeline.reset(); expect(observer).not.toHaveBeenCalled();
});
