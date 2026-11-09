import { expect, it, vi } from 'vitest';
import { DeferredAudioOutput } from './deferred-audio-output.js';
import type { AudioOutputLike } from '@openmoq/player';

function output() {
  let destroyed = false;
  return {
    supportsOutputTiming: true as const,
    currentPlayoutTimeUs: 0,
    schedule: vi.fn(), flush: vi.fn(),
    destroy: vi.fn(() => { destroyed = true; }),
    sampleSourcePosition: (epoch: object) => destroyed ? null : { epoch, sourceTimestampUs: 100n, sourceOffsetUs: 0 },
  } satisfies AudioOutputLike;
}

it.each([false, true])('activation cleanup preserves reentrant successor; restores prior target=%s', restorePrior => {
  const proxy = new DeferredAudioOutput(), prior = output(), distinct = output();
  const next = restorePrior ? prior : distinct;
  proxy.activate(prior);
  const superseded = {
    ...output(),
    get supportsOutputTiming(): true {
      proxy.activate(next);
      return true;
    },
  };
  proxy.activate(superseded);
  expect(proxy.isActive).toBe(true);
  expect(next.destroy, 'outer activation must not destroy the target reactivated by the newer activation').not.toHaveBeenCalled();
  const epoch = {};
  expect(proxy.sampleSourcePosition(epoch)).toEqual({ epoch, sourceTimestampUs: 100n, sourceOffsetUs: 0 });
  expect(superseded.destroy).toHaveBeenCalledOnce();
  proxy.destroy();
});

it.each(['flush', 'flush getter', 'destroy getter'])('retirement rechecks ownership after %s', boundary => {
  const proxy = new DeferredAudioOutput(), prior = output(), next = output();
  proxy.activate(prior);
  let reentered = false;
  const restore = () => { if (!reentered) { reentered = true; proxy.activate(prior); } };
  if (boundary === 'flush') prior.flush.mockImplementation(restore);
  else {
    const name = boundary === 'flush getter' ? 'flush' : 'destroy';
    const original = prior[name];
    Object.defineProperty(prior, name, { get() { restore(); return original; } });
  }
  proxy.activate(next);
  expect(prior.destroy).not.toHaveBeenCalled();
  expect(next.destroy).toHaveBeenCalledOnce();
  const epoch = {};
  expect(proxy.sampleSourcePosition(epoch)).toEqual({ epoch, sourceTimestampUs: 100n, sourceOffsetUs: 0 });
  proxy.destroy();
});
