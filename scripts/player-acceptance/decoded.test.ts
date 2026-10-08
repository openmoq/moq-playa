import { describe, expect, it, vi } from 'vitest';
import type { VideoDecoderLike } from '../../packages/player/src/interfaces.js';
import { observeDecodedSource } from '../../examples/_tests/player-acceptance/decoded.js';

function setup() {
  const decoder: VideoDecoderLike = {
    configure: vi.fn(), decode: vi.fn(), flush: vi.fn(async () => {}), reset: vi.fn(), destroy: vi.fn(),
    queueDepth: 0, onFrame: null, onError: null,
  };
  const observer = observeDecodedSource();
  const wrapper = observer.wrap(decoder);
  wrapper.onFrame = vi.fn();
  const source = Object.freeze({ ticks: 90001n, ticksPerSecond: 90000n, domain: 'media' as const });
  wrapper.decode({ type: 'key', timestamp: 1000011, data: Uint8Array.of(1), sourceTimestamp: source }, 123);
  return { decoder, observer, wrapper, source };
}

describe('decoded source acceptance observer', () => {
  it('compares output scalars with the actual input and preserves frame ownership and schedule', () => {
    const { decoder, observer, wrapper, source } = setup();
    const frame = { timestamp: 1000011, close: vi.fn() };
    decoder.onFrame!(frame, 123, { ...source });
    expect(observer.snapshot()).toMatchObject({ inputs: 1, outputs: 1, matched: 1, failures: ['decoded source was mutable'] });
    expect(wrapper.onFrame).toHaveBeenCalledWith(frame, 123, source);
    expect(frame.close).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong-domain', 'wrong-ticks', 'wrong-scale'] as const)('rejects %s output metadata', (mode) => {
    const { decoder, observer, source } = setup();
    const received = mode === 'missing' ? null : Object.freeze({
      ...source, ...(mode === 'wrong-domain' ? { domain: 'unix' as const } : {}),
      ...(mode === 'wrong-ticks' ? { ticks: 90002n } : {}),
      ...(mode === 'wrong-scale' ? { ticksPerSecond: 48000n } : {}),
    });
    decoder.onFrame!({ timestamp: 1000011 }, 123, received);
    expect(observer.snapshot().matched).toBe(0);
    expect(observer.snapshot().failures).toEqual(['decoded source did not match its input']);
  });

  it('does not accept unsolicited output as evidence and keeps a bounded failure list', () => {
    const { decoder, observer, source } = setup();
    for (let i = 0; i < 1024; i++) decoder.onFrame!({ timestamp: i }, 0, source);
    expect(observer.snapshot().matched).toBe(0);
    expect(observer.snapshot().failures).toHaveLength(16);
  });

  it('positive control keeps exact input/output evidence', () => {
    const { decoder, observer, source } = setup();
    decoder.onFrame!({ timestamp: 1000011 }, 123, source);
    expect(observer.snapshot()).toEqual({ inputs: 1, outputs: 1, matched: 1, failures: [] });
  });

  it.each(['number', 'string'] as const)('rejects %s source scalars even when their text matches', (kind) => {
    const { decoder, observer, source } = setup();
    const corrupt = Object.freeze({ ...source,
      ticks: kind === 'number' ? 90001 : '90001',
      ticksPerSecond: kind === 'number' ? 90000 : '90000',
    });
    decoder.onFrame!({ timestamp: 1000011 }, 123, corrupt as unknown as typeof source);
    expect(observer.snapshot().matched).toBe(0);
    expect(observer.snapshot().failures).toEqual(['decoded source did not match its input']);
  });
});
