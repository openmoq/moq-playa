import { describe, expect, it, vi } from 'vitest';
import {
  advanceCursor, cursorFromSnapshot, decodeMessage, MAX_MESSAGE_BYTES, refreshCursor,
} from '@openmoq/devtools-protocol';
import type { Batch, Fact, Snapshot } from '@openmoq/devtools-protocol';
import { fixtureSource, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { DiagnosticCapture } from './capture.js';
import type { CaptureOptions, CaptureLease } from './types.js';

function setup(options: Partial<CaptureOptions> = {}) {
  let time = 0;
  const now = vi.fn(() => time);
  const source = new DiagnosticCapture({ source: fixtureSource, clock: { id: 'clock', now }, ...options });
  return { source, now, at: (value: number) => { time = value; } };
}
function decoded(text: string) {
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  const result = decodeMessage(text);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.message;
}
function snapshot(text: string): Snapshot {
  const result = decoded(text);
  if (result.kind !== 'snapshot') throw new Error('Expected snapshot');
  return result;
}
function batch(text: string | null): Batch {
  expect(text).not.toBeNull();
  const result = decoded(text!);
  if (result.kind !== 'batch') throw new Error('Expected batch');
  return result;
}
function control(name = 'SUBSCRIBE'): Fact {
  return { kind: 'control', sessionId: 's', streamId: null, requestId: null, messageType: name, direction: 'received' };
}
function object(deliveryId: string, overrides: Partial<Extract<Fact, {kind:'object'}>> = {}): Fact {
  return { ...snapshotFixture.facts[3].fact, deliveryId, ...overrides };
}
function current(lease: CaptureLease): Snapshot {
  return snapshot(lease.refresh('refresh').at(-1)!);
}

describe('bounded diagnostic capture', () => {
  it('does no clock reads or fact access with no attachment', () => {
    const { source, now } = setup();
    const fact = new Proxy(control(), { get() { throw new Error('must not project'); } });
    expect(source.emit(fact, 'dense')).toBe(false);
    expect(now).not.toHaveBeenCalled();
  });

  it('captures a baseline during activation and starts delivery after that snapshot', () => {
    let source!: DiagnosticCapture;
    const activity = vi.fn((active: boolean) => { if (active) source.emit(control(), 'sparse'); });
    source = setup({ onActiveChange: activity }).source;
    const a = source.attach('owner', 'attach');
    expect(source.active).toBe(true);
    const initial = snapshot(a.snapshot);
    expect(initial.watermark).toBe('1');
    expect(initial.facts.map(o => o.fact)).toEqual([control()]);
    expect(a.lease.pull()).toBeNull();
    source.emit(control('FETCH'), 'sparse');
    expect(advanceCursor(cursorFromSnapshot(initial), batch(a.lease.pull())).kind).toBe('accept');
    expect(activity).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('copies projected data and never reads an unknown media or credential field', () => {
    const { source } = setup();
    const a = source.attach('owner', 'attach');
    const fact = { ...snapshotFixture.facts[1].fact, identity: { namespace: ['ab'], name: 'cd' },
      get payload() { throw new Error('media'); }, get token() { throw new Error('secret'); } };
    expect(source.emit(fact, 'sparse')).toBe(true);
    fact.identity.namespace[0] = 'ef';
    const event = batch(a.lease.pull()).events[0]!;
    expect(event.fact).toMatchObject({ identity: { namespace: ['ab'], name: 'cd' } });
    expect(event.fact).not.toHaveProperty('payload');
    expect(event.fact).not.toHaveProperty('token');
    expect(current(a.lease).facts[0]!.fact).toEqual(event.fact);
  });

  it('keeps slow-consumer losses separate, ordered, and contiguous on refresh', () => {
    const { source } = setup({ limits: { pendingMaxEvents: 2 } });
    const fast = source.attach('fast', 'a');
    const slow = source.attach('slow', 'b');
    let fastCursor = cursorFromSnapshot(snapshot(fast.snapshot));
    for (let i = 0; i < 5; i++) {
      source.emit(control(), i % 2 ? 'sparse' : 'dense');
      const b = batch(fast.lease.pull());
      const next = advanceCursor(fastCursor, b);
      expect(next.kind).toBe('accept');
      if (next.kind === 'accept') { expect(next.lost).toBe(false); fastCursor = next.cursor; }
    }
    const frames = slow.lease.refresh('r');
    expect(frames).toHaveLength(2);
    const b = batch(frames[0]!);
    expect(b).toMatchObject({ fromSeq: '1', toSeq: '5', dropped: { dense: '2', sparse: '1' } });
    expect(b.events.map(e => e.seq)).toEqual(['4', '5']);
    const next = advanceCursor(cursorFromSnapshot(snapshot(slow.snapshot)), b);
    expect(next.kind).toBe('accept');
    if (next.kind === 'accept') expect(refreshCursor(next.cursor, snapshot(frames[1]!)).kind).toBe('accept');
    expect(slow.lease.pull()).toBeNull();
    source.emit(control(), 'sparse');
    expect(batch(slow.lease.pull()).fromSeq).toBe('6');
    expect(current(fast.lease).retention.evictedDense).toBe('0');
  });

  it('retains a drops-only batch for invalid and oversized observations', () => {
    const { source } = setup({ limits: { pendingMaxBytes: 512 } });
    const a = source.attach('owner', 'a');
    expect(source.emit({ ...snapshotFixture.facts[1].fact, identity: { namespace: ['ab'.repeat(4000)], name: 'cd' } }, 'dense')).toBe(true);
    expect(source.emit({ ...object('bad'), payloadBytes: Infinity } as Fact, 'sparse')).toBe(false);
    expect(batch(a.lease.pull())).toMatchObject({ fromSeq: '1', toSeq: '2', events: [], dropped: { dense: '1', sparse: '1' } });
    source.emit(control(), 'dense');
    expect(batch(a.lease.pull()).fromSeq).toBe('3');
  });

  it('coalesces state separately from event history and reports all source evictions', () => {
    const { source } = setup({ limits: { stateMaxEvents: 1, historyMaxEvents: 2 } });
    const a = source.attach('owner', 'a');
    source.emit(snapshotFixture.facts[1].fact, 'sparse');
    source.emit({ ...snapshotFixture.facts[1].fact, codec: 'new' }, 'sparse');
    for (let i = 0; i < 3; i++) source.emit(object(`d${i}`), 'dense');
    const s = current(a.lease);
    expect(s.retention).toMatchObject({ retainedEvents: 3, evictedDense: '1', evictedSparse: '1' });
    expect(s.facts.map(o => o.fact.kind)).toEqual(['track', 'object', 'object']);
    expect(s.facts[0]!.fact).toMatchObject({ codec: 'new' });
  });

  it('bounds state across all keys and keeps metric null distinct from a literal dash', () => {
    const { source } = setup({ limits: { stateMaxEvents: 2 } });
    const a = source.attach('owner', 'a');
    source.emit(snapshotFixture.facts[1].fact, 'sparse');
    const metric = snapshotFixture.facts[4].fact;
    source.emit({ ...metric, sessionId: null }, 'sparse');
    source.emit({ ...metric, sessionId: '-' }, 'sparse');
    const s = current(a.lease);
    expect(s.retention).toMatchObject({ retainedEvents: 2, evictedSparse: '1' });
    expect(s.facts.map(o => o.fact)).toEqual([{ ...metric, sessionId: null }, { ...metric, sessionId: '-' }]);
  });

  it('ages history on read while preserving current state', () => {
    const { source, at } = setup({ limits: { historyMaxAgeMs: 10 } });
    const a = source.attach('owner', 'a');
    source.emit(snapshotFixture.facts[1].fact, 'sparse');
    source.emit(object('d'), 'dense');
    at(11);
    const s = current(a.lease);
    expect(s.facts.map(o => o.fact.kind)).toEqual(['track']);
    expect(s.retention).toMatchObject({ retainedEvents: 1, evictedDense: '1' });
    // A source retention eviction is not a delivery drop: that queue still held it.
    expect(s.retention.evictedSparse).toBe('0');
  });

  it('uses UTF-8 bytes, not character count, for both storage and delivery bounds', () => {
    const { source } = setup({ limits: { historyMaxBytes: 512, pendingMaxBytes: 512 } });
    const a = source.attach('owner', 'a');
    const fact: Fact = { kind: 'failure', stage: 'dial', outcome: 'error', attribution: 'unknown',
      sessionId: null, requestId: null, attemptId: null, message: '🟡'.repeat(100), code: null, codeSpace: null };
    source.emit(fact, 'sparse');
    expect(batch(a.lease.pull())).toMatchObject({ events: [], dropped: { sparse: '1' } });
    expect(current(a.lease).retention).toMatchObject({ retainedEvents: 0, retainedBytes: 0, evictedSparse: '1' });
  });

  it('omits whole snapshot facts when their combined encoding exceeds the wire budget', () => {
    const { source } = setup({ limits: { stateMaxEvents: 80, stateMaxBytes: 1000000, pendingMaxBytes: MAX_MESSAGE_BYTES - 2048 } });
    const a = source.attach('owner', 'a');
    for (let i = 0; i < 80; i++) source.emit({ ...snapshotFixture.facts[1].fact,
      trackId: `track-${i}`, identity: { namespace: ['ab'.repeat(3000)], name: 'cd' } }, 'sparse');
    const frames = a.lease.refresh('r');
    for (const frame of frames) decoded(frame);
    const s = snapshot(frames.at(-1)!);
    expect(s.omittedFacts).toBeGreaterThan(0);
    expect(s.facts.length + s.omittedFacts).toBe(80);
    expect(s.retention.retainedEvents).toBe(80);
    for (const o of s.facts) expect(o.fact).toMatchObject({ identity: { namespace: ['ab'.repeat(3000)] } });
  });

  it('never exceeds the schema array bound even with a larger source retention budget', () => {
    const { source } = setup({ limits: { historyMaxEvents: 2100 } });
    const a = source.attach('owner', 'a');
    for (let i = 0; i < 2100; i++) source.emit(control(), 'dense');
    const s = current(a.lease);
    expect(s.facts.length).toBeLessThanOrEqual(2048);
    expect(s.omittedFacts + s.facts.length).toBe(2100);
  });

  it('detail refreshes do not drain delivery or alter its cursor', () => {
    const { source } = setup();
    const a = source.attach('owner', 'a');
    source.emit(object('yes'), 'dense');
    source.emit(object('no', { sessionId: 'other' }), 'dense');
    source.emit({ kind: 'stage', deliveryId: 'yes', unitId: null, stage: 'decoded', reason: null }, 'dense');
    const detail = a.lease.refresh('detail', { kind: 'group', sessionId: 'session-1', trackAlias: '100', groupId: '9007199254740993' });
    expect(detail).toHaveLength(1);
    expect(snapshot(detail[0]!).facts.map(o => o.fact)).toEqual([object('yes')]);
    const delivery = snapshot(a.lease.refresh('d', { kind: 'delivery', deliveryId: 'yes' })[0]!);
    expect(delivery.facts.map(o => o.fact.kind)).toEqual(['object', 'stage']);
    const track = snapshot(a.lease.refresh('t', { kind: 'track', trackId: 'video-1' })[0]!);
    expect(track.facts).toHaveLength(2);
    const b = batch(a.lease.pull());
    expect(b).toMatchObject({ fromSeq: '1', toSeq: '3' });
    expect(advanceCursor(cursorFromSnapshot(snapshot(a.snapshot)), b).kind).toBe('accept');
  });

  it('makes closed leases inert and reattaches with fresh identity, same clock and advancing sequence', () => {
    const activity = vi.fn();
    const { source, now, at } = setup({ onActiveChange: activity });
    const a = source.attach('owner', 'a');
    source.emit(control(), 'dense');
    a.lease.close(); a.lease.close();
    expect(source.active).toBe(false);
    const calls = now.mock.calls.length;
    source.emit(control(), 'sparse');
    expect(now).toHaveBeenCalledTimes(calls);
    at(100);
    const b = source.attach('owner', 'b');
    const s = snapshot(b.snapshot);
    expect(b.lease.target).toMatchObject({ sourceId: a.lease.target.sourceId, runId: a.lease.target.runId });
    expect(b.lease.target.attachmentId).not.toBe(a.lease.target.attachmentId);
    expect(s).toMatchObject({ watermark: '1', facts: [], clocks: [{ id: 'clock', unit: 'ms', kind: 'monotonic' }] });
    expect(a.lease.pull()).toBeNull();
    expect(a.lease.refresh('old')).toEqual([]);
    source.emit(control(), 'sparse');
    expect(batch(b.lease.pull())).toMatchObject({ fromSeq: '2', toSeq: '2', events: [{ timeMs: 100 }] });
    b.lease.close();
    expect(activity.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('does not expose mutable descriptor, clock or lease target authority', () => {
    const descriptor = { ...fixtureSource, label: 'original' };
    const clock = { id: 'clock', now: () => 1 };
    const { source } = setup({ source: descriptor, clock });
    descriptor.label = 'modified'; clock.id = 'changed'; clock.now = () => 50;
    const a = source.attach('owner', 'a');
    const target = a.lease.target as { ownerId: string };
    target.ownerId = 'intruder';
    source.emit(control(), 'dense');
    expect(batch(a.lease.pull())).toMatchObject({ target: { ownerId: 'owner' }, events: [{ clockId: 'clock', timeMs: 1 }] });
    expect(current(a.lease).source.label).toBe('original');
  });

  it('reports source end after queued delivery, drains once, and never claims a transport close', () => {
    const activity = vi.fn();
    const { source } = setup({ onActiveChange: activity, limits: { pendingMaxEvents: 1, pendingMaxBytes: 512 } });
    const a = source.attach('owner', 'a');
    source.emit(control(), 'dense');
    source.dispose(); source.dispose();
    expect(source.active).toBe(false);
    const b = batch(a.lease.pull());
    expect(b).toMatchObject({ fromSeq: '1', toSeq: '2', dropped: { dense: '1', sparse: '0' } });
    expect(b.events.map(e => e.fact)).toEqual([{ kind: 'source_state', state: 'ended', reason: 'disposed' }]);
    expect(a.lease.pull()).toBeNull();
    expect(current(a.lease).facts.some(o => o.fact.kind === 'source_state')).toBe(true);
    expect(source.emit(control(), 'dense')).toBe(false);
    expect(() => source.attach('owner', 'new')).toThrow(/ended/);
    a.lease.close();
    expect(activity.mock.calls).toEqual([[true], [false]]);
  });

  it('timestamps explicit disposal at the disposal observation, not at the previous event', () => {
    const { source, at } = setup();
    const a = source.attach('owner', 'a');
    at(10); source.emit(control(), 'sparse');
    at(40); source.dispose();
    expect(batch(a.lease.pull()).events.at(-1)).toMatchObject({ timeMs: 40,
      fact: { kind: 'source_state', reason: 'disposed' } });
  });

  it('contains reentrant clock access instead of exhausting the stack or evading attachment limits', () => {
    let source!: DiagnosticCapture;
    let calls = 0;
    source = setup({ clock: { id: 'clock', now() {
      if (++calls > 1) source.attach('nested', 'nested');
      return 1;
    } }, limits: { maxAttachments: 2 } }).source;
    const a = source.attach('owner', 'a');
    expect(() => source.attach('owner', 'b')).toThrow(/ended/);
    expect(calls).toBe(2);
    expect(batch(a.lease.pull()).events.at(-1)!.fact).toMatchObject({ kind: 'source_state', reason: 'clock-error' });
  });

  it('does not move a capture begun under a detached activation into a reattached lease', () => {
    const { source } = setup();
    const a = source.attach('owner', 'a');
    let b: ReturnType<DiagnosticCapture['attach']> | undefined;
    const fact = { ...control(), get messageType() {
      a.lease.close(); b = source.attach('owner', 'b'); return 'SUBSCRIBE';
    } } as Fact;
    expect(source.emit(fact, 'sparse')).toBe(false);
    expect(b!.lease.pull()).toBeNull();
    expect(current(b!.lease).facts).toEqual([]);
    expect(source.emit(control(), 'sparse')).toBe(true);
    expect(batch(b!.lease.pull()).events).toHaveLength(1);
  });

  it('accepts source refresh after a clock failure and discloses termination before its watermark', () => {
    const { source, at } = setup();
    const a = source.attach('owner', 'a');
    at(Infinity);
    const frames = a.lease.refresh('r');
    expect(frames).toHaveLength(2);
    expect(batch(frames[0]!).events[0]!.fact).toEqual({ kind: 'source_state', state: 'ended', reason: 'clock-error' });
    expect(snapshot(frames[1]!).watermark).toBe('1');
  });

  it.each([NaN, Infinity, -1, 9])('ends on invalid/regressing clock %s without corrupting the last good time', time => {
    const { source, at } = setup();
    at(10);
    const a = source.attach('owner', 'a');
    source.emit(control(), 'sparse');
    at(time);
    expect(() => source.emit(control(), 'dense')).not.toThrow();
    const b = batch(a.lease.pull());
    expect(b.events.at(-1)).toMatchObject({ timeMs: 10, fact: { kind: 'source_state', reason: 'clock-error' } });
    expect(source.active).toBe(false);
  });

  it('does not reset the monotonic clock on reattach', () => {
    const { source, at } = setup();
    at(50);
    const a = source.attach('owner', 'a'); a.lease.close();
    at(49);
    expect(() => source.attach('owner', 'b')).toThrow(/ended/);
    expect(source.active).toBe(false);
  });

  it('contains activity and clock exceptions; teardown is still idempotent', () => {
    const { source } = setup({ onActiveChange: () => { throw new Error('observer'); } });
    const a = source.attach('owner', 'a');
    expect(source.emit(control(), 'dense')).toBe(true);
    expect(() => a.lease.close()).not.toThrow();
    const broken = setup({ clock: { id: 'bad-clock', now() { throw new Error('clock'); } } }).source;
    expect(() => broken.attach('owner', 'a')).toThrow(/ended/);
    expect(broken.active).toBe(false);
  });

  it('owns an accidentally asynchronous activity failure without waiting for it', async () => {
    let observed = 0;
    const { source } = setup({ onActiveChange: () => ({ then(_resolve: unknown, reject: (error: Error) => void) {
      observed++; reject(new Error('observer rejected'));
    } }) });
    const a = source.attach('owner', 'a');
    expect(source.active).toBe(true);
    a.lease.close();
    expect(source.active).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(observed).toBe(2);
  });

  it('does not resurrect a source disposed during activation', () => {
    let source!: DiagnosticCapture;
    source = setup({ onActiveChange: active => { if (active) source.dispose(); } }).source;
    expect(() => source.attach('owner', 'a')).toThrow(/ended/);
    expect(source.active).toBe(false);
  });

  it('caps attachments and validates commands before changing pending state', () => {
    const { source } = setup({ limits: { maxAttachments: 1 } });
    expect(() => source.attach('bad owner', 'a')).toThrow();
    const a = source.attach('owner', 'a');
    expect(() => source.attach('owner', 'b')).toThrow(/limit/);
    source.emit(control(), 'dense');
    expect(() => a.lease.refresh('bad request')).toThrow();
    expect(batch(a.lease.pull()).fromSeq).toBe('1');
    a.lease.close();
    expect(() => source.attach('owner', 'b')).not.toThrow();
  });

  it('reserves the last uint64 sequence for an explicit end without wrapping', () => {
    const { source } = setup();
    // Exercise the unreachable-in-practice boundary without a production sequence override.
    (source as unknown as { sequence: bigint }).sequence = 0xfffffffffffffffen;
    const a = source.attach('owner', 'a');
    expect(source.emit(control(), 'dense')).toBe(false);
    const b = batch(a.lease.pull());
    expect(b).toMatchObject({ fromSeq: '18446744073709551615', toSeq: '18446744073709551615' });
    expect(b.events[0]!.fact).toEqual({ kind: 'source_state', state: 'ended', reason: 'sequence-exhausted' });
    expect(advanceCursor(cursorFromSnapshot(snapshot(a.snapshot)), b).kind).toBe('accept');
    expect(a.lease.pull()).toBeNull();
  });

  it.each([NaN, Infinity, 0, -1, 1.5])('rejects invalid limits %s before any activation', value => {
    for (const key of ['stateMaxEvents', 'stateMaxBytes', 'historyMaxEvents', 'historyMaxBytes',
      'historyMaxAgeMs', 'pendingMaxEvents', 'pendingMaxBytes', 'maxAttachments']) {
      expect(() => setup({ limits: { [key]: value } })).toThrow();
    }
  });

  it('rejects unsafe aggregate and wire budgets', () => {
    expect(() => setup({ limits: { pendingMaxEvents: 2049 } })).toThrow();
    expect(() => setup({ limits: { pendingMaxBytes: MAX_MESSAGE_BYTES } })).toThrow();
    expect(() => setup({ limits: { pendingMaxBytes: 511 } })).toThrow();
    expect(() => setup({ limits: { stateMaxBytes: Number.MAX_SAFE_INTEGER } })).toThrow();
  });
});
