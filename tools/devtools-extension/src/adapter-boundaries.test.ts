/**
 * Boundaries the adapter must hold against VALID input: a peer-chosen
 * identifier never sizes an allocation; alias bindings are session-scoped and
 * never override explicit identity; snapshots cannot rewind the stream, reset
 * view state or replay detail into live counters; retention is bounded for
 * every fact kind; summaries, offsets and metrics keep their stated meaning;
 * disposal is part of the source interface.
 */
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '@openmoq/devtools-protocol';
import type { Batch, Fact, Message, Observation, Snapshot } from '@openmoq/devtools-protocol';
import { batchFixture, gapFixture, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { ProtocolSource } from './adapter.js';

type VM = Record<string, any>;
const observe = (fact: Fact, timeMs = 20): Observation => ({ clockId: 'mock-clock', timeMs, fact });
function decoded<T extends Message>(input: T): T {
  const result = decodeMessage(encodeMessage(input));
  if (!result.ok) throw new Error(result.error.code);
  return result.message as T;
}
function make() {
  let view: VM = {};
  const source = new ProtocolSource((next: VM) => { view = next; }, { groupsRetained: 2 });
  source.applySnapshot(decoded(snapshotFixture));
  return { source, view: () => view };
}
function batch(facts: readonly Fact[], from = 6): Batch {
  return { ...batchFixture, fromSeq: String(from), toSeq: String(from + facts.length - 1),
    events: facts.map((fact, i) => ({ ...observe(fact, 20 + i), seq: String(from + i) })) };
}

describe('adapter boundaries', () => {
  it('bounds grid allocation for a single valid uint64 object ID', () => {
    const { source, view } = make();
    const message = decoded(batch([{ ...batchFixture.events[0].fact, objectId: '18446744073709551615' }]));
    expect(() => source.applyBatch(message)).not.toThrow();
    expect(view().columns).toBeLessThanOrEqual(256);
    expect(view().rows.every((r: VM) => r.cells.length <= 256)).toBe(true);
  });

  it('bounds grid allocation for a valid terminal bound', () => {
    const { source, view } = make();
    const message = decoded(batch([{ kind: 'group_bound', sessionId: 'session-1', trackAlias: '100',
      groupId: '9007199254740993', objectId: '18446744073709551615', bound: 'exclusive', evidence: 'end-of-group' }]));
    expect(() => source.applyBatch(message)).not.toThrow();
    expect(view().columns).toBeLessThanOrEqual(256);
  });

  it('keeps anonymous objects from another session out of the selected alias', () => {
    const { source, view } = make();
    source.applyBatch(decoded(batch([{ ...batchFixture.events[0].fact,
      sessionId: 'other-session', trackId: null, groupId: '9007199254740994' }])));
    expect(view().rows.map((r: VM) => r.label)).toEqual(['g 9007199254740993']);
  });

  it('uses the full session/alias binding when object track ID is unavailable', () => {
    const { source, view } = make();
    source.applyBatch(decoded(batch([{ ...batchFixture.events[0].fact,
      trackId: null, groupId: '9007199254740994' }])));
    expect(view().rows.map((r: VM) => r.label)).toContain('g 9007199254740994');
  });

  it('does not override a known object track with an alias fallback', () => {
    const { source, view } = make();
    source.applyBatch(decoded(batch([{ ...batchFixture.events[0].fact,
      sessionId: 'other-session', trackId: 'audio-1', groupId: '9007199254740994' }])));
    expect(view().rows.map((r: VM) => r.label)).toEqual(['g 9007199254740993']);
  });

  it('does not rewind the stream on a stale source snapshot', () => {
    const { source, view } = make();
    source.applyBatch(decoded(batchFixture));
    source.applyBatch(decoded(gapFixture));
    const before = view();
    source.applySnapshot(decoded(snapshotFixture));
    expect(source.cursor?.watermark).toBe('9');
    expect(view().rows).toEqual(before.rows);
  });

  it('preserves Pause and selected mode through a current resnapshot', () => {
    const { source, view } = make();
    source.setMode('probe');
    source.togglePause();
    source.applySnapshot(decoded({ ...snapshotFixture, watermark: '6' }));
    expect(view().paused).toBe(true);
    expect(view().mode).toBe('probe');
  });

  it('does not apply scoped history back into global counters', () => {
    const { source, view } = make();
    const control: Fact = { kind: 'control', sessionId: 'session-1', streamId: '4', requestId: '2',
      messageType: 'SUBSCRIBE_OK', direction: 'received' };
    source.applyBatch(decoded(batch([control])));
    const before = view().events;
    const detail: Snapshot = { ...snapshotFixture, watermark: '6', facts: [observe(control)],
      scope: { kind: 'group', sessionId: 'session-1', trackAlias: '100', groupId: '9007199254740993' } };
    source.applySnapshot(decoded(detail));
    expect(view().events).toEqual(before);
    expect(source.cursor?.watermark).toBe('6');
  });

  it.each(['group_bound', 'group_summary'] as const)('applies group retention to %s-only traffic', kind => {
    const { source } = make();
    const facts: Fact[] = Array.from({ length: 16 }, (_, i) => kind === 'group_bound'
      ? { kind, sessionId: 'session-1', trackAlias: '100', groupId: String(i),
        objectId: '1', bound: 'exclusive', evidence: 'end-of-group' }
      : { kind, sessionId: 'session-1', trackAlias: '100', groupId: String(i),
        observedObjects: '1', observedBytes: '20', completeCapture: true });
    source.applyBatch(decoded(batch(facts)));
    expect(source.groups.size).toBeLessThanOrEqual(2);
  });

  it('uses a source summary count when object details are no longer retained', () => {
    const { source, view } = make();
    const summary: Fact = { kind: 'group_summary', sessionId: 'session-1', trackAlias: '100', groupId: '42',
      observedObjects: '12', observedBytes: '1000', completeCapture: false };
    source.applySnapshot(decoded({ ...snapshotFixture,
      facts: [snapshotFixture.facts[0], snapshotFixture.facts[1], snapshotFixture.facts[2], observe(summary)] }));
    expect(view().rows[0].meta).toMatch(/12 obs/);
    expect(view().rows[0].meta).not.toContain('0 obs');
  });

  it('starts arrival offsets at the first object, not an earlier group bound', () => {
    const { source, view } = make();
    const bound: Fact = { kind: 'group_bound', sessionId: 'session-1', trackAlias: '100', groupId: '42',
      objectId: '5', bound: 'exclusive', evidence: 'end-of-group' };
    source.applySnapshot(decoded({ ...snapshotFixture, facts: [snapshotFixture.facts[0],
      snapshotFixture.facts[1], snapshotFixture.facts[2], observe(bound, 10),
      observe({ ...batchFixture.events[0].fact, groupId: '42', objectId: '0' }, 100)] }));
    source.selectCell('session-1/100/42', '0');
    expect(view().selected.find((r: string[]) => r[0] === 'arrival offset')[1]).toBe('+0 ms');
  });

  it('does not show another track\'s metric for the selected video', () => {
    const { source, view } = make();
    const metric: Fact = { ...snapshotFixture.facts[4].fact, value: 999,
      unavailable: null, trackId: 'audio-1' };
    source.applyBatch(decoded(batch([metric])));
    expect(view().sparks[0].now).not.toContain('999');
  });

  it('does not label a single latency sample as a measured p50', () => {
    const { source, view } = make();
    const metric: Fact = { ...snapshotFixture.facts[4].fact, value: 40, unavailable: null };
    source.applyBatch(decoded(batch([metric])));
    expect(view().sparks[0].now).toContain('40');
    expect(view().sparks[0].name).not.toMatch(/p50|median/i);
  });

  it('supports disposal through the panel\'s common source interface', () => {
    const { source } = make();
    expect(() => source.destroy()).not.toThrow();
  });
});
