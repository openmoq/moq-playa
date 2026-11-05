/** Isolated synchronous assembly/ownership controls; no native MSE output claim. */
import { expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, readCmafChunkSamples, serializeLocmafObject } from '@openmoq/locmaf';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { boxSize } from '../../browser/src/mp4-box.js';
import { buildChunk, buildInit, NON_SYNC_FLAGS, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import type { MoqtPlayerConfig } from './config.js';
import type { CmafAssemblerLike } from './interfaces.js';
import { preflightMseOutputs, type PreparedMseOutput } from './prepared-mse-output.js';

type Factory = NonNullable<MoqtPlayerConfig['createCmafAssembler']>;
type Callbacks = Parameters<Factory>[0];
const object = (payload: Uint8Array, id = 0n, group = 7n): MoqtObject => ({ kind: 'data', payload,
  trackAlias: varint(10), groupId: varint(group), objectId: varint(id), subgroupId: varint(0), publisherPriority: 0 });
function outputs(): PreparedMseOutput[] {
  return (['video', 'audio'] as const).map(role => {
    const scale = role === 'video' ? 90000 : 48000, raw = role === 'video' ? 90_080_000n : 900_080_000n;
    const ctoUs = role === 'video' ? 40000n : 10000n, trackId = role === 'video' ? 11 : 21;
    return { role, trackName: role, sourceKey: JSON.stringify([['prepared', role], role]), packaging: 'cmaf',
      init: buildInit({ trackId, timescale: scale, handler: role === 'video' ? 'vide' : 'soun' }),
      anchor: { sourceTimeUs: role === 'video' ? 90_000_000n : 900_000_000n, rebasedTimeUs: { numerator: 10_000_000n, denominator: 1n } },
      objects: [object(buildChunk({ trackId, bmdt: (raw - ctoUs) * BigInt(scale) / 1_000_000n,
        samples: [{ duration: scale / 50, size: 4, flags: SYNC_FLAGS, cto: Number(ctoUs * BigInt(scale) / 1_000_000n) }],
        mdat: Uint8Array.of(trackId, 2, 3, 4) }))] };
  });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function liveFixture() {
  const output = vi.fn(), live = new CmafAssembler({ onSegment: output }), init = outputs()[0]!.init;
  live.setInitSegment('video', init);
  live.push('video', 'playing', 1n, buildChunk({ trackId: 11, bmdt: 90_000_000n,
    samples: [{ duration: 1800, size: 4, flags: SYNC_FLAGS }] }), undefined, undefined, 'live');
  const placement = live.capturePresentationPlacement('video'), epoch = live.getEpoch('video'), delivered = output.mock.calls.length;
  return { live, unchanged() {
    expect(live.getEpoch('video')).toBe(epoch); expect(live.capturePresentationPlacement('video')).toBe(placement);
    expect(output).toHaveBeenCalledTimes(delivered);
  } };
}
function factory(decorate?: (owned: CmafAssembler, callbacks: Callbacks) => void, intercept?: (callbacks: Callbacks) => Callbacks) {
  const destroyed = vi.fn(), created: CmafAssembler[] = [], pushed: Array<Parameters<CmafAssembler['push']>> = [];
  const create: Factory = vi.fn(callbacks => {
    const owned = new CmafAssembler(intercept?.(callbacks) ?? callbacks), destroy = owned.destroy.bind(owned), push = owned.push.bind(owned);
    owned.destroy = () => { destroyed(); destroy(); };
    owned.push = (...args) => { pushed.push(args); return push(...args); };
    created.push(owned); decorate?.(owned, callbacks); return owned;
  });
  return { create, created, destroyed, pushed };
}

it('preflights actual A/V emissions at mapped PTS while retaining composition offsets and raw bytes', () => {
  const planned = outputs(), originals = planned.map(output => output.objects.map(object => object.kind === 'data' ? object.payload.slice() : null));
  const originalInits = planned.map(output => output.init.slice());
  const liveOutput = vi.fn(), live = new CmafAssembler({ onSegment: liveOutput });
  const emissions: Array<{ role: 'video' | 'audio'; bytes: Uint8Array; name: string; key: string | undefined }> = [];
  let owned: CmafAssembler | undefined;
  const destroyed = vi.fn();
  const create: Factory = options => {
    owned = new CmafAssembler({ ...options, onSegment(...args) {
      emissions.push({ role: args[0], bytes: args[1].slice(), name: args[2], key: args[5] }); options.onSegment(...args);
    } });
    const destroy = owned.destroy.bind(owned); owned.destroy = () => { destroyed(); destroy(); };
    return owned;
  };
  expect(() => preflightMseOutputs(create, live, planned, () => {})).not.toThrow();
  expect(destroyed).toHaveBeenCalledOnce(); expect(liveOutput).not.toHaveBeenCalled();
  expect(emissions).toHaveLength(2);
  for (const [index, output] of planned.entries()) {
    const emitted = emissions[index]!;
    expect(emitted.name).toBe(output.trackName); expect(emitted.key).toBe(output.sourceKey);
    const context = parseLocmafTrackContext(output.init), read = readCmafChunkSamples(emitted.bytes, context).effective;
    expect((read.baseMediaDecodeTime + BigInt(read.compositionTimeOffsets[0] ?? 0)) * 1_000_000n / BigInt(context.timescale)).toBe(10_080_000n);
    expect(read.compositionTimeOffsets[0]).toBe(output.role === 'video' ? 3600 : 480);
    expect(output.init).toEqual(originalInits[index]);
    expect(output.objects.map(object => object.kind === 'data' ? object.payload : null)).toEqual(originals[index]);
  }
});

it('refuses a factory returning the live assembler before any capability read, mutation or destroy', () => {
  const f = liveFixture(), init = vi.spyOn(f.live, 'setInitSegment'), select = vi.spyOn(f.live, 'selectTrack');
  const place = vi.spyOn(f.live, 'setPresentationPlacement'), push = vi.spyOn(f.live, 'push'), destroy = vi.spyOn(f.live, 'destroy');
  const capability = vi.fn(() => { throw new Error('live capability getter was read'); });
  Object.defineProperty(f.live, 'supportsTrackIdentity', { configurable: true, get: capability });
  const create: Factory = vi.fn(() => f.live);
  expect(() => preflightMseOutputs(create, f.live, outputs(), () => {})).toThrow(/live assembler/);
  expect(create).toHaveBeenCalledOnce(); expect(capability).not.toHaveBeenCalled();
  for (const method of [init, select, place, push, destroy]) expect(method).not.toHaveBeenCalled();
  f.unchanged();
});

it.each(['supportsTrackIdentity', 'setInitSegment', 'selectTrack', 'setPresentationPlacement', 'capturePresentationPlacement'] as const)
('refuses a legacy assembler missing %s and destroys only its owned instance', missing => {
  const f = liveFixture(), destroyed = vi.fn();
  const create: Factory = callbacks => {
    const owned = new CmafAssembler(callbacks);
    const legacy: CmafAssemblerLike = { supportsTrackIdentity: true, push: (...args) => owned.push(...args),
      setInitSegment: (...args) => owned.setInitSegment(...args), selectTrack: (...args) => owned.selectTrack(...args),
      setPresentationPlacement: (...args) => owned.setPresentationPlacement(...args),
      capturePresentationPlacement: role => owned.capturePresentationPlacement(role), getEpoch: role => owned.getEpoch(role),
      reset: () => owned.reset(), destroy() { destroyed(); owned.destroy(); } };
    Reflect.deleteProperty(legacy, missing); return legacy;
  };
  expect(() => preflightMseOutputs(create, f.live, outputs(), () => {})).toThrow(/capabilities/);
  expect(destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it('cleans up an owned factory result when factory reentry cancels the operation', () => {
  const f = liveFixture(); let current = true;
  const owned = factory(() => { current = false; }), cancel = new Error('selection cancelled');
  expect(() => preflightMseOutputs(owned.create, f.live, outputs(), () => { if (!current) throw cancel; })).toThrow(cancel);
  expect(owned.create).toHaveBeenCalledOnce(); expect(owned.destroyed).toHaveBeenCalledOnce(); expect(owned.pushed).toEqual([]); f.unchanged();
});

it('checks ownership after initialization before later preparation or data calls', () => {
  const f = liveFixture(); let current = true;
  const selected = vi.fn(), owned = factory(assembler => {
    const initialize = assembler.setInitSegment.bind(assembler);
    assembler.setInitSegment = (...args) => { initialize(...args); current = false; };
    assembler.selectTrack = selected;
  });
  expect(() => preflightMseOutputs(owned.create, f.live, outputs(), () => { if (!current) throw new Error('initialization cancelled'); })).toThrow(/initialization cancelled/);
  expect(selected).not.toHaveBeenCalled(); expect(owned.pushed).toEqual([]); expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it.each(['before', 'after'] as const)('checks reentrant cancellation %s the owned emission callback', when => {
  const f = liveFixture(); let current = true;
  const capture = vi.fn(() => null), owned = factory(assembler => { assembler.capturePresentationPlacement = capture; },
    callbacks => ({ ...callbacks, onSegment(...args) {
      if (when === 'before') current = false;
      callbacks.onSegment(...args);
      if (when === 'after') current = false;
    } }));
  expect(() => preflightMseOutputs(owned.create, f.live, outputs(), () => { if (!current) throw new Error('emission cancelled'); })).toThrow(/emission cancelled/);
  expect(capture).not.toHaveBeenCalled(); expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it('does not let a swallowed constructor callback count as a data emission', () => {
  const f = liveFixture(), planned = outputs(), owned = factory((_assembler, callbacks) => {
    const first = planned[0]!, media = first.objects[0]!;
    if (media.kind !== 'data') throw new Error('Fixture has no data');
    try { callbacks.onSegment('video', media.payload, first.trackName, 7n, undefined, first.sourceKey); } catch { /* Deliberately swallowed by this custom factory. */ }
  });
  expect(() => preflightMseOutputs(owned.create, f.live, planned, () => {})).toThrow(/current media push/);
  expect(owned.pushed).toEqual([]); expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it('refuses a cached callback during placement capture even if the adapter swallows its exception', () => {
  const f = liveFixture(), planned = outputs(), owned = factory((assembler, callbacks) => {
    const capture = assembler.capturePresentationPlacement.bind(assembler);
    assembler.capturePresentationPlacement = role => {
      const spec = planned.find(output => output.role === role)!, media = spec.objects[0]!;
      if (media.kind !== 'data') throw new Error('Fixture has no data');
      try { callbacks.onSegment(role, media.payload, spec.trackName, 7n, undefined, spec.sourceKey); } catch { /* Custom adapter swallows callback rejection. */ }
      return capture(role);
    };
  });
  expect(() => preflightMseOutputs(owned.create, f.live, planned, () => {})).toThrow(/current media push/);
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it.each(['role', 'key', 'name', 'group'] as const)('refuses an emission with the wrong current-push %s', mismatch => {
  const f = liveFixture(), destroyed = vi.fn();
  const create: Factory = callbacks => {
    const owned = new CmafAssembler({ ...callbacks, onSegment(role, bytes, name, group, inputs, key) {
      callbacks.onSegment(mismatch === 'role' ? 'audio' : role, bytes, mismatch === 'name' ? 'other label' : name,
        mismatch === 'group' ? group + 1n : group, inputs, mismatch === 'key' ? 'other key' : key);
    } });
    const destroy = owned.destroy.bind(owned); owned.destroy = () => { destroyed(); destroy(); }; return owned;
  };
  expect(() => preflightMseOutputs(create, f.live, outputs(), () => {})).toThrow(/current media push/);
  expect(destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it.each(['malformed', 'missing mdat', 'pending tail'] as const)('refuses %s media while retaining the live placement', bad => {
  const f = liveFixture(), planned = outputs(), audio = planned[1]!, original = audio.objects[0]!;
  if (original.kind !== 'data') throw new Error('Fixture has no data');
  const partial = original.payload.subarray(0, boxSize(original.payload, 0));
  planned[1] = { ...audio, objects: bad === 'malformed' ? [object(Uint8Array.of(1, 2, 3))]
    : bad === 'missing mdat' ? [object(partial)] : [original, object(partial, 0n, 8n)] };
  const owned = factory();
  expect(() => preflightMseOutputs(owned.create, f.live, planned, () => {})).toThrow();
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it.each([-1n, 1n << 64n])('refuses mapped tfdt outside the unsigned 64-bit range: %s', rebased => {
  const f = liveFixture(), planned = outputs()[0]!, owned = factory();
  const invalid: PreparedMseOutput = { ...planned, init: buildInit({ trackId: 11, timescale: 1000000, handler: 'vide' }),
    anchor: { sourceTimeUs: 0n, rebasedTimeUs: { numerator: rebased, denominator: 1n } },
    objects: [object(buildChunk({ trackId: 11, bmdt: 0n, samples: [{ duration: 1, size: 1, flags: SYNC_FLAGS }] }))] };
  expect(() => preflightMseOutputs(owned.create, f.live, [invalid], () => {})).toThrow(/did not emit/);
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it('requires the first emitted video sample to be RAP even if a later chunk is sync', () => {
  const f = liveFixture(), planned = outputs()[0]!, owned = factory();
  const dependent = buildChunk({ trackId: 11, bmdt: 8_100_000n, samples: [{ duration: 1800, size: 1, flags: NON_SYNC_FLAGS }] });
  const sync = buildChunk({ trackId: 11, bmdt: 8_101_800n, samples: [{ duration: 1800, size: 1, flags: SYNC_FLAGS }] });
  expect(() => preflightMseOutputs(owned.create, f.live, [{ ...planned, objects: [object(concat(dependent, sync))] }], () => {})).toThrow(/random access/);
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it('handles paired moof/mdat exactly once without passing diagnostic input tokens', () => {
  const f = liveFixture(), planned = outputs(), owned = factory();
  for (const [index, spec] of planned.entries()) {
    const media = spec.objects[0]!; if (media.kind !== 'data') throw new Error('Fixture has no data');
    const end = boxSize(media.payload, 0);
    planned[index] = { ...spec, objects: [object(media.payload.subarray(0, end)), object(media.payload.subarray(end), 1n)] };
  }
  expect(() => preflightMseOutputs(owned.create, f.live, planned, () => {})).not.toThrow();
  expect(owned.create).toHaveBeenCalledOnce(); expect(owned.pushed).toHaveLength(4);
  for (const args of owned.pushed) { expect(args[4]).toBeUndefined(); expect(args[5]).toBeUndefined(); expect(args[6]).toBe(planned.find(output => output.role === args[0])?.sourceKey); }
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

function locmafOutputs(): PreparedMseOutput[] {
  return outputs().map(spec => {
    const context = parseLocmafTrackContext(spec.init), encoder = new LocmafEncoder(), state = new LocmafGroupState();
    return { ...spec, packaging: 'locmaf', objects: [0, 1].map(index => {
      const raw = spec.role === 'video' ? 8_100_000n : 43_200_000n;
      const bytes = buildChunk({ trackId: context.trackId, bmdt: raw + BigInt(index * (context.timescale / 50)),
        samples: [{ duration: context.timescale / 50, size: 4, flags: index === 0 || spec.role === 'audio' ? SYNC_FLAGS : NON_SYNC_FLAGS }] });
      return object(serializeLocmafObject(encoder.encode(bytes, state, context, index === 0, BigInt(index))), BigInt(index));
    }) };
  });
}
it('uses separate local LOCMAF reconstruction state for both roles sharing a group and object IDs', () => {
  const f = liveFixture(), planned = locmafOutputs(), originals = planned.map(spec => spec.objects.map(object => object.kind === 'data' ? object.payload.slice() : null));
  const owned = factory();
  expect(() => preflightMseOutputs(owned.create, f.live, planned, () => {})).not.toThrow();
  expect(owned.pushed).toHaveLength(4); expect(owned.create).toHaveBeenCalledOnce(); expect(owned.destroyed).toHaveBeenCalledOnce();
  for (const [index, spec] of planned.entries()) expect(spec.objects.map(object => object.kind === 'data' ? object.payload : null)).toEqual(originals[index]);
  f.unchanged();
});
it('rejects a LOCMAF delta-first group instead of borrowing live or another role state', () => {
  const f = liveFixture(), spec = locmafOutputs()[0]!, owned = factory();
  expect(() => preflightMseOutputs(owned.create, f.live, [{ ...spec, objects: [spec.objects[1]!] }], () => {})).toThrow();
  expect(owned.pushed).toEqual([]); expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it('requires a delivered placement capture for each required role', () => {
  const f = liveFixture(), owned = factory(assembler => { assembler.capturePresentationPlacement = () => null; });
  expect(() => preflightMseOutputs(owned.create, f.live, outputs(), () => {})).toThrow(/delivered presentation placement/);
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it('refuses missing placement evidence even when the capture method exists', () => {
  const f = liveFixture(), owned = factory(assembler => {
    Object.defineProperty(assembler, 'capturePresentationPlacement', { value: () => undefined });
  });
  expect(() => preflightMseOutputs(owned.create, f.live, outputs(), () => {})).toThrow(/presentation placement/);
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});

it.each(['promise rejection', 'custom rejection', 'custom fulfillment'] as const)('observes and refuses asynchronous cleanup: %s', async mode => {
  const f = liveFixture(), then = vi.fn(), errors: unknown[] = [], onUnhandled = (error: unknown) => { errors.push(error); };
  const owned = factory(assembler => {
    const destroy = assembler.destroy.bind(assembler);
    assembler.destroy = () => {
      destroy();
      if (mode === 'promise rejection') return Promise.reject(new Error('async destroy failed'));
      return { then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        then(); if (mode === 'custom rejection') reject(new Error('custom destroy failed')); else resolve(undefined);
      } };
    };
  });
  process.on('unhandledRejection', onUnhandled);
  try {
    expect(() => preflightMseOutputs(owned.create, f.live, outputs(), () => {})).toThrow(/asynchronous cleanup/);
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(errors).toEqual([]); expect(owned.destroyed).toHaveBeenCalledOnce();
    if (mode !== 'promise rejection') expect(then).toHaveBeenCalledOnce();
    f.unchanged();
  } finally { process.off('unhandledRejection', onUnhandled); }
});

it('observes a custom cleanup thenable returned rejection chain', async () => {
  const f = liveFixture(), errors: unknown[] = [], onUnhandled = (error: unknown) => { errors.push(error); };
  const owned = factory(assembler => {
    const destroy = assembler.destroy.bind(assembler);
    assembler.destroy = () => { destroy(); return { then: () => Promise.reject(new Error('cleanup chain rejected')) }; };
  });
  process.on('unhandledRejection', onUnhandled);
  try {
    expect(() => preflightMseOutputs(owned.create, f.live, outputs(), () => {})).toThrow(/asynchronous cleanup/);
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(errors).toEqual([]); expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
  } finally { process.off('unhandledRejection', onUnhandled); }
});

it('ignores cached callbacks after owned destruction, including a later cancelled operation', () => {
  const f = liveFixture(); let callbacks: Callbacks | undefined, current = true;
  const owned = factory((_assembler, options) => { callbacks = options; });
  const planned = outputs(); preflightMseOutputs(owned.create, f.live, planned, () => { if (!current) throw new Error('retired'); });
  current = false;
  const media = planned[0]!.objects[0]!; if (media.kind !== 'data') throw new Error('Fixture has no data');
  expect(() => callbacks?.onSegment('video', media.payload, 'video', 7n, undefined, planned[0]!.sourceKey)).not.toThrow();
  expect(owned.destroyed).toHaveBeenCalledOnce(); f.unchanged();
});
