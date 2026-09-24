/**
 * Trace recorder tests — retention bounds, pinned metadata, log tee safety,
 * and the disabled path.
 *
 * @see docs/playout-trace.md
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { parseSeq, type QlogClock } from '@moqt/transport';
import {
  TraceRecorder,
  formatLogMessage,
  DEFAULT_TRACE_LIMITS,
  PLAYA_EVENT_SCHEMA,
  LOGLEVEL_EVENT_SCHEMA,
} from './trace-recorder.js';

const MOQT_SCHEMA = 'urn:ietf:params:qlog:events:moqt-06';
import { NULL_LOGGER } from './logger.js';

/** Manually advanced clock — no wall time in tests. */
function testClock(): QlogClock & { advance(ms: number): void } {
  let t = 0;
  return {
    clock_id: 'test-clock',
    clock_type: 'monotonic',
    now: () => t,
    advance(ms: number) { t += ms; },
  };
}

function recorder(overrides: Partial<Parameters<typeof TraceRecorder.prototype.constructor>[0]> = {}) {
  const clock = testClock();
  const r = new TraceRecorder({
    clock,
    runId: 'run-1',
    eventSchemas: [MOQT_SCHEMA],
    enabled: true,
    ...overrides,
  } as ConstructorParameters<typeof TraceRecorder>[0]);
  return { r, clock };
}

function dumped(r: TraceRecorder) {
  const parsed = parseSeq(r.dump());
  const window = parsed.events.find(e => e.name === 'playa:trace_window')!;
  return {
    parsed,
    window: window.data,
    events: parsed.events.filter(e => !e.name.startsWith('playa:')),
  };
}

describe('TraceRecorder disabled path', () => {
  it('is off by default', () => {
    const clock = testClock();
    const r = new TraceRecorder({
      clock, runId: 'run-1', eventSchemas: [MOQT_SCHEMA],
    });
    expect(r.enabled).toBe(false);
  });

  it('does not read the clock or retain anything while disabled', () => {
    const clock = testClock();
    const now = vi.spyOn(clock, 'now');
    const r = new TraceRecorder({ clock, runId: 'run-1', eventSchemas: [MOQT_SCHEMA] });
    now.mockClear();
    r.record('moqt:a', { v: 1 });
    r.declare('trace_capabilities', { loc: true });
    expect(now).not.toHaveBeenCalled();
    expect(r.size).toBe(0);
  });

  it('captures once started and stops without losing the window', () => {
    const { r } = recorder({ enabled: false });
    r.record('moqt:a', {});
    expect(r.size).toBe(0);
    r.start();
    r.record('moqt:b', {});
    r.stop();
    r.record('moqt:c', {});
    expect(r.size).toBe(1);
    expect(dumped(r).events[0]!.name).toBe('moqt:b');
  });
});

describe('TraceRecorder retention', () => {
  it('evicts by age within a lane', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 100 } });
    r.record('moqt:old', {});
    clock.advance(101);
    r.record('moqt:new', {});
    const { events, window } = dumped(r);
    expect(events.map(e => e.name)).toEqual(['moqt:new']);
    expect((window.dense as Record<string, unknown>).evicted_events).toBe(1);
  });

  it('evicts by event count even inside the age window', () => {
    const { r } = recorder({ limits: { denseMaxEvents: 2 } });
    for (const n of ['a', 'b', 'c', 'd']) r.record(`moqt:${n}`, {});
    const { events, window } = dumped(r);
    expect(events.map(e => e.name)).toEqual(['moqt:c', 'moqt:d']);
    expect((window.dense as Record<string, unknown>).evicted_events).toBe(2);
  });

  it('evicts by bytes — a time-only bound is not protective', () => {
    const { r } = recorder({ limits: { denseMaxBytes: 400 } });
    for (let i = 0; i < 20; i++) r.record('moqt:big', { blob: 'x'.repeat(100) });
    const { window } = dumped(r);
    const dense = window.dense as Record<string, number>;
    expect(dense.bytes).toBeLessThanOrEqual(400);
    expect(dense.evicted_events).toBeGreaterThan(0);
    expect(dense.evicted_bytes).toBeGreaterThan(0);
  });

  it('keeps sparse events after dense ones have aged out', () => {
    const { r, clock } = recorder({
      limits: { denseMaxAgeMs: 100, sparseMaxAgeMs: 10_000 },
    });
    r.record('moq_playout:frame_presented', {}, { lane: 'dense' });
    r.record('moq_playout:playout_stalled', {}, { lane: 'sparse' });
    clock.advance(200);
    r.record('moq_playout:frame_presented', {}, { lane: 'dense' });
    const names = dumped(r).events.map(e => e.name);
    expect(names).toContain('moq_playout:playout_stalled');
    expect(names.filter(n => n === 'moq_playout:frame_presented')).toHaveLength(1);
  });

  it('merges both lanes in timestamp order', () => {
    const { r, clock } = recorder();
    r.record('moqt:t0', {}, { lane: 'dense' });
    clock.advance(10);
    r.record('moqt:t10', {}, { lane: 'sparse' });
    clock.advance(10);
    r.record('moqt:t20', {}, { lane: 'dense' });
    expect(dumped(r).events.map(e => e.name)).toEqual(['moqt:t0', 'moqt:t10', 'moqt:t20']);
  });
});

describe('TraceRecorder window metadata', () => {
  it('reports the window so absence is not read as a discard', () => {
    const { r, clock } = recorder({ limits: { denseMaxEvents: 1 } });
    r.record('moqt:a', {});
    clock.advance(50);
    r.record('moqt:b', {});
    const w = dumped(r).window;
    expect(w.capture_start).toBe(0);
    expect(w.retention_cutoff).toBe(50);
    expect(w.earliest_retained).toBe(50);
    expect(w.clock_id).toBe('test-clock');
    expect(w.clock_type).toBe('monotonic');
    expect((w.dense as Record<string, unknown>).evicted).toBe(true);
  });

  it('reports open lifecycles as unknown when no provider is supplied', () => {
    const { r } = recorder();
    r.record('moqt:a', {});
    expect(dumped(r).window.open_lifecycles).toBe('unknown');
  });

  it('reports the open lifecycle count when a provider is supplied', () => {
    const { r } = recorder({ openLifecycles: () => 3 });
    r.record('moqt:a', {});
    expect(dumped(r).window.open_lifecycles).toBe(3);
  });

  it('dumps a valid sequential qlog even with no events', () => {
    const { r } = recorder();
    const parsed = parseSeq(r.dump());
    expect(parsed.truncated).toBe(false);
    expect(parsed.header.trace.event_schemas).toEqual([MOQT_SCHEMA, PLAYA_EVENT_SCHEMA]);
    expect(parsed.events.map(e => e.name)).toEqual(['playa:trace_window']);
  });
});

describe('TraceRecorder metadata is not evictable', () => {
  it('survives eviction of every event it describes', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 10 } });
    r.declare('trace_capabilities', { loc_lifecycle: true, mse_lifecycle: false });
    r.declare('track_declared', { track_id: 't1' });
    r.record('moqt:a', {});
    clock.advance(1000);
    r.record('moqt:b', {});
    const meta = dumped(r).parsed.events.filter(e => e.name === 'playa:metadata');
    expect(meta.map(e => (e.data as { kind: string }).kind))
      .toEqual(['trace_capabilities', 'track_declared']);
  });

  it('bounds the metadata store independently and reports truncation', () => {
    const { r } = recorder({ limits: { metadataMaxEntries: 2 } });
    r.declare('track_declared', { track_id: 't1' });
    r.declare('track_declared', { track_id: 't2' });
    r.declare('track_declared', { track_id: 't3' });
    const w = dumped(r).window;
    expect(w.metadata_entries).toBe(2);
    expect(w.metadata_truncated).toBe(true);
    expect(w.metadata_dropped).toBe(1);
  });

  it('reports no truncation when everything fits', () => {
    const { r } = recorder();
    r.declare('trace_capabilities', { loc_lifecycle: true });
    expect(dumped(r).window.metadata_truncated).toBe(false);
  });
});

describe('TraceRecorder session grouping', () => {
  it('defaults events to the player run and honours a per-event override', () => {
    const { r } = recorder();
    r.record('moqt:a', {});
    r.record('moqt:b', {}, { groupId: 'session-2' });
    expect(dumped(r).events.map(e => e.group_id)).toEqual(['run-1', 'session-2']);
  });
});

describe('TraceRecorder log tee', () => {
  it('forwards to the base logger unchanged', () => {
    const { r } = recorder();
    const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const tee = r.logger(base);
    tee.warn('careful', 1);
    expect(base.warn).toHaveBeenCalledWith('careful', 1);
  });

  it('records log output under the standard loglevel namespace', () => {
    const { r } = recorder();
    const tee = r.logger(NULL_LOGGER);
    tee.error('boom');
    tee.warn('hmm');
    tee.info('fyi');
    tee.debug('detail');
    expect(dumped(r).events.map(e => e.name)).toEqual([
      'loglevel:error', 'loglevel:warning', 'loglevel:info', 'loglevel:debug',
    ]);
  });

  it('keeps log events in the sparse lane so they outlive per-unit events', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 10, sparseMaxAgeMs: 10_000 } });
    r.logger(NULL_LOGGER).warn('kept');
    clock.advance(500);
    r.record('moqt:later', {});
    expect(dumped(r).events.map(e => e.name)).toContain('loglevel:warning');
  });
});

describe('safe log formatting', () => {
  const MAX = DEFAULT_TRACE_LIMITS.maxLogMessageChars;

  it('formats primitives without stringifying', () => {
    expect(formatLogMessage('v', [1, true, undefined, null, 'x'], MAX))
      .toBe('v 1 true undefined null x');
  });

  it('handles BigInt, which JSON.stringify throws on', () => {
    expect(formatLogMessage('id', [2n ** 62n], MAX)).toBe('id 4611686018427387904n');
  });

  it('handles a cyclic object without recursing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => formatLogMessage('c', [cyclic], MAX)).not.toThrow();
    expect(formatLogMessage('c', [cyclic], MAX)).toBe('c [Object]');
  });

  it('summarizes an Error rather than dropping it', () => {
    expect(formatLogMessage('e', [new TypeError('bad')], MAX)).toBe('e TypeError: bad');
  });

  it('summarizes typed arrays by length, not contents', () => {
    expect(formatLogMessage('b', [new Uint8Array(4096)], MAX))
      .toBe('b [Uint8Array byteLength=4096]');
  });

  it('does not expand an object with a throwing getter', () => {
    const hostile = { get boom(): never { throw new Error('no'); } };
    expect(() => formatLogMessage('h', [hostile], MAX)).not.toThrow();
  });

  it('bounds the message length inclusive of the truncation marker', () => {
    const out = formatLogMessage('x'.repeat(5000), [], 100);
    expect(out.length).toBe(100);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });
});

describe('TraceRecorder fault containment', () => {
  it('never throws into the caller and reports the fault', () => {
    const { r } = recorder();
    const hostile = { toJSON() { throw new Error('nope'); } };
    expect(() => r.record('moqt:a', { hostile })).not.toThrow();
    expect(dumped(r).window.recorder_faults).toBe(1);
  });

  it('clear() discards events and metadata', () => {
    const { r } = recorder();
    r.declare('trace_capabilities', {});
    r.record('moqt:a', {});
    r.clear();
    expect(r.size).toBe(0);
    expect(dumped(r).parsed.events.map(e => e.name)).toEqual(['playa:trace_window']);
  });
});

// ─── Retention accounting, ordering, and non-interference ───────────

describe('byte bounds are UTF-8, not UTF-16', () => {
  it('counts multi-byte characters at their encoded size', () => {
    // 100 emoji: ~208 UTF-16 units but ~408 UTF-8 bytes. A cap between the
    // two must evict, and a code-unit count would wrongly retain.
    const { r } = recorder({ limits: { denseMaxBytes: 350 } });
    r.record('moqt:unicode', { e: '😀'.repeat(100) });
    const dense = dumped(r).window.dense as Record<string, number>;
    expect(dense.retained).toBe(0);
    expect(dense.evicted_events).toBe(1);
    expect(dense.evicted_bytes).toBeGreaterThan(350);
  });

  it('reports retained bytes in UTF-8', () => {
    const { r } = recorder();
    r.record('moqt:unicode', { e: '😀' });
    const dense = dumped(r).window.dense as Record<string, number>;
    const framedChars = JSON.stringify({ time: 0, name: 'moqt:unicode', data: { e: '😀' }, group_id: 'run-1' }).length;
    expect(dense.bytes).toBeGreaterThan(framedChars);
  });

  it('applies the UTF-8 bound to metadata too', () => {
    // The cap sits between the record's UTF-16 length (~270) and its UTF-8
    // size (~470), so a code-unit count would wrongly accept it.
    const { r } = recorder({ limits: { metadataMaxBytes: 350 } });
    r.declare('big', { e: '😀'.repeat(100) });
    const w = dumped(r).window;
    expect(w.metadata_entries).toBe(0);
    expect(w.metadata_truncated).toBe(true);
  });
});

describe('metadata is snapshotted at declaration', () => {
  it('ignores later mutation of the declared object', () => {
    const { r } = recorder();
    const data: Record<string, unknown> = { x: 'ok' };
    r.declare('track_declared', data);
    data.x = 'y'.repeat(10_000);
    const meta = dumped(r).parsed.events.find(e => e.name === 'playa:metadata')!;
    expect((meta.data as { data: { x: string } }).data.x).toBe('ok');
    expect(r.dump().length).toBeLessThan(2_000);
  });

  it('cannot be made to throw at dump time by a later hostile toJSON', () => {
    const { r } = recorder();
    const data: Record<string, unknown> = { x: 1 };
    r.declare('track_declared', data);
    data.toJSON = () => { throw new Error('late'); };
    expect(() => r.dump()).not.toThrow();
  });
});

describe('equal timestamps keep causal order across lanes', () => {
  it('preserves sparse-then-dense insertion order at one tick', () => {
    const { r } = recorder();
    r.record('moq_playout:playout_stalled', {}, { lane: 'sparse' });
    r.record('moqt:second', {}, { lane: 'dense' });
    expect(dumped(r).events.map(e => e.name))
      .toEqual(['moq_playout:playout_stalled', 'moqt:second']);
  });

  it('preserves dense-then-sparse insertion order at one tick', () => {
    const { r } = recorder();
    r.record('moqt:first', {}, { lane: 'dense' });
    r.record('moq_playout:playout_stalled', {}, { lane: 'sparse' });
    expect(dumped(r).events.map(e => e.name))
      .toEqual(['moqt:first', 'moq_playout:playout_stalled']);
  });
});

describe('age is an age bound, not a span bound', () => {
  it('evicts a stale event at dump when no later event arrived', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 100 } });
    r.record('moqt:stale', {});
    clock.advance(1000);
    const { events, window } = dumped(r);
    expect(events).toHaveLength(0);
    expect((window.dense as Record<string, number>).evicted_events).toBe(1);
    expect(window.retention_cutoff).toBe(1000);
  });

  it('freezes the window at stop() rather than drifting with wall clock', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 100 } });
    r.record('moqt:kept', {});
    clock.advance(50);
    r.stop();
    clock.advance(10_000);
    const { events, window } = dumped(r);
    expect(events.map(e => e.name)).toEqual(['moqt:kept']);
    expect(window.capture_end).toBe(50);
    expect(window.retention_cutoff).toBe(50);
    // The dump itself happened later; that is a different fact.
    expect(window.dump_time).toBe(10_050);
  });
});

describe('the logger tee cannot alter playback', () => {
  const hostile = new Proxy({}, { get() { throw new Error('formatter trap'); } });

  it('forwards to the base logger before formatting', () => {
    const { r } = recorder();
    const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const tee = r.logger(base);
    expect(() => tee.warn('careful', hostile)).not.toThrow();
    // Compare by identity: a deep-equality matcher would trip the Proxy traps.
    expect(base.warn).toHaveBeenCalledOnce();
    const [msg, arg] = base.warn.mock.calls[0]!;
    expect(msg).toBe('careful');
    expect(arg).toBe(hostile);
  });

  it('degrades a hostile value to a bounded placeholder', () => {
    const { r } = recorder();
    r.logger(NULL_LOGGER).warn('careful', hostile);
    const events = dumped(r).events;
    expect(events).toHaveLength(1);
    // Every property access on the Proxy is contained, so this degrades
    // cleanly rather than needing the outer fault path.
    expect((events[0]!.data as { message: string }).message).toBe('careful [Object]');
    expect(dumped(r).window.recorder_faults).toBe(0);
  });

  it('does not record when the base logger throws', () => {
    // Base runs first, so its throw propagates normally and the trace does
    // not claim a log line that never happened.
    const { r } = recorder();
    const base = {
      error: () => { throw new Error('sink down'); },
      warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
    };
    expect(() => r.logger(base).error('boom')).toThrow('sink down');
    expect(r.size).toBe(0);
  });

  it('does not format while the recorder is disabled', () => {
    const { r } = recorder({ enabled: false });
    const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const tee = r.logger(base);
    expect(() => tee.warn('careful', hostile)).not.toThrow();
    expect(base.warn).toHaveBeenCalledOnce();
    expect(r.size).toBe(0);
  });

  it('preserves the call shape rather than rendering placeholders', () => {
    const { r } = recorder();
    r.logger(NULL_LOGGER).info('subscribed %s at %d', 'video', 42);
    const msg = (dumped(r).events[0]!.data as { message: string }).message;
    expect(msg).toBe('subscribed %s at %d video 42');
  });
});

describe('schema declarations', () => {
  it('always lists the private playa schema, since every dump has a window', () => {
    const { r } = recorder();
    const schemas = parseSeq(r.dump()).header.trace.event_schemas;
    expect(schemas).toContain(PLAYA_EVENT_SCHEMA);
  });

  it('lists the standard loglevel schema only once a log event is retained', () => {
    const { r } = recorder();
    expect(parseSeq(r.dump()).header.trace.event_schemas)
      .not.toContain(LOGLEVEL_EVENT_SCHEMA);
    r.logger(NULL_LOGGER).info('hi');
    expect(parseSeq(r.dump()).header.trace.event_schemas)
      .toContain(LOGLEVEL_EVENT_SCHEMA);
  });

  it('does not retain a mutable caller-owned schema array', () => {
    const clock = testClock();
    const schemas = [MOQT_SCHEMA];
    const r = new TraceRecorder({ clock, runId: 'run-1', eventSchemas: schemas, enabled: true });
    schemas.push('https://evil.example/injected');
    expect(parseSeq(r.dump()).header.trace.event_schemas)
      .not.toContain('https://evil.example/injected');
  });

  it('rejects an unnamespaced event name via the shared validator', () => {
    const { r } = recorder();
    r.record('not-namespaced', {});
    expect(r.size).toBe(0);
    expect(dumped(r).window.recorder_faults).toBe(1);
  });
});

describe('start/stop coverage is self-consistent', () => {
  it('restarting begins a new capture rather than keeping stale events', () => {
    const { r, clock } = recorder();
    r.record('moqt:before', {});
    r.stop();
    clock.advance(100);
    r.start();
    r.record('moqt:after', {});
    const { events, window } = dumped(r);
    expect(events.map(e => e.name)).toEqual(['moqt:after']);
    expect(window.capture_start).toBe(100);
    expect(window.earliest_retained).toBe(100);
  });

  it('keeps pinned metadata across a restart', () => {
    const { r } = recorder();
    r.declare('trace_capabilities', { loc_lifecycle: true });
    r.stop();
    r.start();
    expect(dumped(r).parsed.events.some(e => e.name === 'playa:metadata')).toBe(true);
  });
});

describe('openLifecycles provider is contained', () => {
  it('reports unknown when the provider throws', () => {
    const { r } = recorder({ openLifecycles: () => { throw new Error('boom'); } });
    const w = dumped(r).window;
    expect(w.open_lifecycles).toBe('unknown');
    expect(w.recorder_faults).toBe(1);
  });

  it('reports unknown for a nonsensical value rather than emitting it', () => {
    for (const bad of [NaN, -1, 1.5, Infinity]) {
      const { r } = recorder({ openLifecycles: () => bad });
      expect(dumped(r).window.open_lifecycles).toBe('unknown');
    }
  });
});

describe('limit validation', () => {
  it('rejects non-finite ages that would silently disable the bound', () => {
    const clock = testClock();
    for (const denseMaxAgeMs of [NaN, Infinity, -1]) {
      expect(() => new TraceRecorder({
        clock, runId: 'r', eventSchemas: [MOQT_SCHEMA], limits: { denseMaxAgeMs },
      })).toThrow(RangeError);
    }
  });

  it('rejects non-integer or non-positive counts and byte caps', () => {
    const clock = testClock();
    for (const denseMaxEvents of [0, -5, 1.5, NaN, Infinity]) {
      expect(() => new TraceRecorder({
        clock, runId: 'r', eventSchemas: [MOQT_SCHEMA], limits: { denseMaxEvents },
      })).toThrow(RangeError);
    }
  });

  it('rejects a log cap too small for its own truncation marker', () => {
    const clock = testClock();
    expect(() => new TraceRecorder({
      clock, runId: 'r', eventSchemas: [MOQT_SCHEMA], limits: { maxLogMessageChars: 4 },
    })).toThrow(RangeError);
  });
});

describe('sparse lane bounds', () => {
  it('evicts by sparse event count', () => {
    const { r } = recorder({ limits: { sparseMaxEvents: 2 } });
    for (const n of ['a', 'b', 'c']) r.record(`moqt:${n}`, {}, { lane: 'sparse' });
    expect(dumped(r).events.map(e => e.name)).toEqual(['moqt:b', 'moqt:c']);
  });

  it('evicts by sparse bytes', () => {
    const { r } = recorder({ limits: { sparseMaxBytes: 400 } });
    for (let i = 0; i < 20; i++) {
      r.record('moqt:big', { blob: 'x'.repeat(100) }, { lane: 'sparse' });
    }
    const sparse = dumped(r).window.sparse as Record<string, number>;
    expect(sparse.bytes).toBeLessThanOrEqual(400);
    expect(sparse.evicted_events).toBeGreaterThan(0);
  });

  it('stays correct through sustained eviction past saturation', () => {
    const { r } = recorder({ limits: { denseMaxEvents: 100 } });
    for (let i = 0; i < 5_000; i++) r.record('moqt:x', { i });
    const { events, window } = dumped(r);
    expect(events).toHaveLength(100);
    expect((events[0]!.data as { i: number }).i).toBe(4_900);
    expect((window.dense as Record<string, number>).evicted_events).toBe(4_900);
  });
});

// ─── Dump atomicity, private-event ordering, and namespace policy ───

describe('dump() is atomic against a re-entrant provider', () => {
  it('counts and rows agree when the provider records during the dump', () => {
    const clock = testClock();
    let r!: TraceRecorder;
    r = new TraceRecorder({
      clock, runId: 'run-1', eventSchemas: [MOQT_SCHEMA], enabled: true,
      openLifecycles: () => { r.record('moqt:sneak', {}); return 1; },
    });
    const { parsed, window } = dumped(r);
    const rows = parsed.events.filter(e => !e.name.startsWith('playa:'));
    // The provider ran before the snapshot, so its event is in the file and
    // counted — not counted while absent.
    expect(rows.map(e => e.name)).toEqual(['moqt:sneak']);
    expect((window.dense as Record<string, number>).retained).toBe(1);
  });

  it('counts and rows agree when the provider clears during the dump', () => {
    const clock = testClock();
    let r!: TraceRecorder;
    r = new TraceRecorder({
      clock, runId: 'run-1', eventSchemas: [MOQT_SCHEMA], enabled: true,
      openLifecycles: () => { r.clear(); return 0; },
    });
    r.record('moqt:doomed', {});
    const { parsed, window } = dumped(r);
    const rows = parsed.events.filter(e => !e.name.startsWith('playa:'));
    expect(rows).toHaveLength(0);
    expect((window.dense as Record<string, number>).retained).toBe(0);
  });

  it('refuses a recursive dump rather than emitting an inconsistent file', () => {
    const clock = testClock();
    let r!: TraceRecorder;
    r = new TraceRecorder({
      clock, runId: 'run-1', eventSchemas: [MOQT_SCHEMA], enabled: true,
      openLifecycles: () => { r.dump(); return 1; },
    });
    expect(() => r.dump()).not.toThrow();
    const w = dumped(r).window;
    expect(w.open_lifecycles).toBe('unknown');
    expect(w.recorder_faults).toBeGreaterThan(0);
  });
});

describe('private event timestamps and ordering', () => {
  it('stamps metadata when declared and orders every record chronologically', () => {
    const clock = testClock();
    const r = new TraceRecorder({
      clock, runId: 'run-1', eventSchemas: [MOQT_SCHEMA], enabled: true,
    });
    clock.advance(150);
    r.declare('track_declared', { track_id: 't1' });
    r.record('moqt:x', {});
    clock.advance(50);
    // Assert the full record list, including playa:*; filtering them hid this.
    expect(parseSeq(r.dump()).events.map(e => ({ name: e.name, time: e.time }))).toEqual([
      { name: 'playa:metadata', time: 150 },
      { name: 'moqt:x', time: 150 },
      { name: 'playa:trace_window', time: 200 },
    ]);
  });

  it('places the window last even for a stopped capture', () => {
    const { r, clock } = recorder();
    r.record('moqt:x', {});
    clock.advance(10);
    r.stop();
    clock.advance(500);
    const events = parseSeq(r.dump()).events;
    expect(events[events.length - 1]!.name).toBe('playa:trace_window');
    expect(events[events.length - 1]!.time).toBe(510);
  });
});

describe('recorder-owned namespaces are reserved', () => {
  it('rejects a caller-authored playa event', () => {
    const { r } = recorder();
    r.record('playa:invented', {});
    expect(r.size).toBe(0);
    expect(dumped(r).window.recorder_faults).toBe(1);
  });

  it('rejects a caller-authored loglevel event', () => {
    const { r } = recorder();
    r.record('loglevel:invented', {});
    expect(r.size).toBe(0);
    // The header must not claim the loglevel schema for an event we refused.
    expect(parseSeq(r.dump()).header.trace.event_schemas).not.toContain(LOGLEVEL_EVENT_SCHEMA);
  });

  it('still admits the logger tee through its internal path', () => {
    const { r } = recorder();
    r.logger(NULL_LOGGER).info('hello');
    expect(dumped(r).events.map(e => e.name)).toEqual(['loglevel:info']);
  });
});

describe('schema URI validation', () => {
  const clock = testClock();
  const make = (eventSchemas: string[]) =>
    () => new TraceRecorder({ clock, runId: 'r', eventSchemas });

  it('rejects empty, relative, and malformed values', () => {
    for (const bad of ['', 'foo/bar', '   ', '//example.com/x']) {
      expect(make([bad])).toThrow(RangeError);
    }
  });

  it('accepts urn: and https: forms', () => {
    expect(make([MOQT_SCHEMA])).not.toThrow();
    expect(make(['https://openmoq.org/082026/moq_playout'])).not.toThrow();
  });

  it('dedupes repeated values', () => {
    const r = new TraceRecorder({
      clock, runId: 'r', eventSchemas: [MOQT_SCHEMA, MOQT_SCHEMA], enabled: true,
    });
    expect(parseSeq(r.dump()).header.trace.event_schemas)
      .toEqual([MOQT_SCHEMA, PLAYA_EVENT_SCHEMA]);
  });
});

describe('exported formatter enforces its own contract', () => {
  it('rejects a cap it could not honour', () => {
    expect(() => formatLogMessage('abcdef', [], 1)).toThrow(RangeError);
  });

  it('honours a cap large enough for the marker', () => {
    const out = formatLogMessage('abcdef', [], 13);
    expect(out.length).toBeLessThanOrEqual(13);
  });
});

describe('quiet-lane age is enforced before dump', () => {
  it('reports the correct size after a sibling lane advances the clock', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 100, sparseMaxAgeMs: 10_000 } });
    r.record('moqt:stale', {}, { lane: 'dense' });
    clock.advance(1000);
    r.record('moq_playout:playout_stalled', {}, { lane: 'sparse' });
    // The dense event is outside its window; size must not still claim it.
    expect(r.size).toBe(1);
  });

  it('evicts on stop as well', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 100 } });
    r.record('moqt:stale', {});
    clock.advance(1000);
    r.stop();
    expect(r.size).toBe(0);
  });
});

describe('every limit key is validated', () => {
  const clock = testClock();
  const KEYS = [
    'denseMaxAgeMs', 'denseMaxEvents', 'denseMaxBytes',
    'sparseMaxAgeMs', 'sparseMaxEvents', 'sparseMaxBytes',
    'metadataMaxEntries', 'metadataMaxBytes', 'maxLogMessageChars',
  ] as const;

  it('rejects NaN for every key', () => {
    for (const key of KEYS) {
      expect(
        () => new TraceRecorder({
          clock, runId: 'r', eventSchemas: [MOQT_SCHEMA], limits: { [key]: NaN },
        }),
        `${key} must reject NaN`,
      ).toThrow(RangeError);
    }
  });

  it('rejects a negative value for every key', () => {
    for (const key of KEYS) {
      expect(
        () => new TraceRecorder({
          clock, runId: 'r', eventSchemas: [MOQT_SCHEMA], limits: { [key]: -1 },
        }),
        `${key} must reject -1`,
      ).toThrow(RangeError);
    }
  });
});

// ─── qlog serialization conformance ─────────────────────────────────

/** Every key in the emitted JSON, recursively. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const item of v) allKeys(item, out);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      out.push(k);
      allKeys(val, out);
    }
  }
  return out;
}

describe('emitted field names are lowercase (QLOG-MAIN §11.2)', () => {
  it('pins the exact limits keys', () => {
    const { r } = recorder();
    const limits = dumped(r).window.limits as Record<string, unknown>;
    expect(Object.keys(limits)).toEqual([
      'dense_max_age_ms', 'dense_max_events', 'dense_max_bytes',
      'sparse_max_age_ms', 'sparse_max_events', 'sparse_max_bytes',
      'metadata_max_entries', 'metadata_max_bytes', 'max_log_message_chars',
    ]);
  });

  it('has no uppercase key anywhere in a populated dump', () => {
    const { r } = recorder();
    r.declare('trace_capabilities', { loc_lifecycle: true });
    r.record('moqt:a', { b: 1 });
    r.logger(NULL_LOGGER).info('hi');
    for (const event of parseSeq(r.dump()).events) {
      const offenders = allKeys(event.data).filter(k => k !== k.toLowerCase());
      expect(offenders, `${event.name} must have lowercase field names`).toEqual([]);
    }
  });
});

describe('time values are float64 milliseconds (QLOG-MAIN §1.2)', () => {
  it('carries fractional clock values through the window unrounded', () => {
    let t = 0.5;
    const clock: QlogClock = { clock_id: 'frac', clock_type: 'monotonic', now: () => t };
    const r = new TraceRecorder({
      clock, runId: 'run-1', eventSchemas: [MOQT_SCHEMA], enabled: true,
    });
    r.record('moqt:a', {});
    t = 12.25;
    const w = parseSeq(r.dump()).events.find(e => e.name === 'playa:trace_window')!;
    expect(w.time).toBe(12.25);
    expect((w.data as Record<string, unknown>).capture_start).toBe(0.5);
    expect((w.data as Record<string, unknown>).earliest_retained).toBe(0.5);
  });

  it('accepts a fractional age limit', () => {
    const clock = testClock();
    expect(() => new TraceRecorder({
      clock, runId: 'r', eventSchemas: [MOQT_SCHEMA], limits: { denseMaxAgeMs: 16.5 },
    })).not.toThrow();
  });
});

describe('schema URIs are validated raw, not normalized', () => {
  const clock = testClock();
  const make = (uri: string) =>
    () => new TraceRecorder({ clock, runId: 'r', eventSchemas: [uri] });

  it('rejects characters outside the RFC 3986 grammar', () => {
    const NUL = String.fromCharCode(0);
    const BACKTICK = String.fromCharCode(96);
    for (const bad of [
      'https://example.com/{schema}',
      'https://example.com/|schema',
      'https://example.com/"schema',
      'urn:example:^schema',
      `urn:example:${BACKTICK}schema`,
      `urn:example:${NUL}schema`,
      'urn:exámple:x',
    ]) {
      expect(make(bad), `must reject ${JSON.stringify(bad)}`).toThrow(RangeError);
    }
  });

  it('rejects multiple fragment delimiters and an empty fragment', () => {
    expect(make('https://example.com/a#b#c')).toThrow(RangeError);
    expect(make('https://example.com/a#')).toThrow(RangeError);
  });

  it('accepts a non-empty extension fragment (QLOG-MAIN §8)', () => {
    expect(make('urn:ietf:params:qlog:events:moqt#playout')).not.toThrow();
  });

  it('rejects brackets outside an IP-literal authority', () => {
    expect(make('urn:example:[schema]')).toThrow(RangeError);
    expect(make('https://example.com/[schema]')).toThrow(RangeError);
    expect(make('https://[::1[/x')).toThrow(RangeError);
  });

  it('accepts an IPv6 literal authority, with and without a port', () => {
    expect(make('https://[2001:db8::1]/schema')).not.toThrow();
    expect(make('https://[2001:db8::1]:8443/schema')).not.toThrow();
  });

  it('reports a non-string without a second throwable operation', () => {
    // JSON.stringify(1n) throws TypeError; the promised error is RangeError.
    expect(() => new TraceRecorder({
      clock, runId: 'r', eventSchemas: [1n as unknown as string],
    })).toThrow(RangeError);
  });

  it('rejects values new URL() would silently repair', () => {
    // Each of these parses via WHATWG URL but as a *different* string than we
    // would serialize, so accepting them would change a schema identity.
    expect(make(' https://example.com/schema ')).toThrow(RangeError);
    expect(make('https://example.com/a b')).toThrow(RangeError);
    expect(make('https:\\\\example.com\\\\schema')).toThrow(RangeError);
  });

  it('rejects malformed percent escapes', () => {
    expect(make('https://example.com/%zz')).toThrow(RangeError);
    expect(make('https://example.com/%2')).toThrow(RangeError);
  });

  it('accepts well-formed percent escapes', () => {
    expect(make('https://example.com/a%20b')).not.toThrow();
  });

  it('rejects a non-string at the runtime boundary', () => {
    expect(() => new TraceRecorder({
      clock, runId: 'r', eventSchemas: [42 as unknown as string],
    })).toThrow(RangeError);
  });

  it('rejects before the first clock read even when enabled', () => {
    const spy = testClock();
    const now = vi.spyOn(spy, 'now');
    expect(() => new TraceRecorder({
      clock: spy, runId: 'r', eventSchemas: ['not a uri'], enabled: true,
    })).toThrow(RangeError);
    expect(now).not.toHaveBeenCalled();
  });
});

describe('declare() advances retention like any other operation', () => {
  it('sweeps even when the metadata cap rejects the declaration', () => {
    // Retention cannot depend on whether the independent metadata store had
    // capacity for this particular row.
    const { r, clock } = recorder({
      limits: { metadataMaxEntries: 1, denseMaxAgeMs: 10 },
    });
    r.declare('first', {});
    r.record('moqt:stale', {});
    clock.advance(100);
    r.declare('dropped', {});
    expect(r.size).toBe(0);
    expect(dumped(r).window.metadata_dropped).toBe(1);
  });

  it('sweeps a stale lane so pre-dump size is honest', () => {
    const { r, clock } = recorder({ limits: { denseMaxAgeMs: 10 } });
    r.record('moqt:stale', {});
    clock.advance(100);
    r.declare('track_declared', { track_id: 't1' });
    expect(r.size).toBe(0);
  });
});

describe('the truncation cap boundary', () => {
  it('honours a cap of exactly the marker length', () => {
    expect(formatLogMessage('x'.repeat(100), [], 12)).toBe('…[truncated]');
  });

  it('still rejects a cap below the marker length', () => {
    expect(() => formatLogMessage('x', [], 11)).toThrow(RangeError);
  });
});
