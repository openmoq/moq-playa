/**
 * Total retention and scoped evidence. Every retained collection has a
 * finite, validated budget; eviction is by observation order, never by a
 * comparison of group numbers across tracks or sessions; metrics, run
 * identity and window bounds keep their exact meaning.
 */
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '@openmoq/devtools-protocol';
import type { Batch, Fact, Message, Snapshot } from '@openmoq/devtools-protocol';
import { batchFixture, gapFixture, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { ProtocolSource } from './adapter.js';
import type { ViewModel } from './adapter.js';

function decoded<T extends Message>(input: T): T {
  const result = decodeMessage(encodeMessage(input));
  if (!result.ok) throw new Error(result.error.code);
  return result.message as T;
}
function make() {
  const budgets = { groups: 2, sessions: 2, tracks: 2, aliases: 2, discardsPerDelivery: 2,
    requests: 2, stages: 2, objectsPerGroup: 2, cells: 256, dialAttempts: 2 };
  let view: ViewModel;
  const source = new ProtocolSource(next => { view = next; }, { budgets });
  source.applySnapshot(decoded(snapshotFixture));
  return { source, view: () => view! };
}
function batch(facts: readonly Fact[], from = 6): Batch {
  return { ...batchFixture, fromSeq: String(from), toSeq: String(from + facts.length - 1),
    events: facts.map((fact, i) => ({ seq: String(from + i), clockId: 'mock-clock', timeMs: 20 + i, fact })) };
}

describe('total retention and scoped evidence', () => {
  it('limits total groups even when every group has a different alias', () => {
    const { source } = make();
    const facts: Fact[] = Array.from({ length: 16 }, (_, i) => ({ kind: 'group_bound',
      sessionId: 'session-1', trackAlias: String(i), groupId: '0', objectId: '1',
      bound: 'exclusive', evidence: 'end-of-group' }));
    source.applyBatch(decoded(batch(facts)));
    expect(source.groups.size).toBeLessThanOrEqual(2);
  });

  it('limits retained sessions', () => {
    const { source } = make();
    source.applyBatch(decoded(batch(Array.from({ length: 16 }, (_, i) => ({
      ...snapshotFixture.facts[0].fact, sessionId: `session-${i}`,
    })))));
    expect(source.sessions.size).toBeLessThanOrEqual(2);
  });

  it('limits retained track descriptions', () => {
    const { source } = make();
    source.applyBatch(decoded(batch(Array.from({ length: 16 }, (_, i) => ({
      ...snapshotFixture.facts[1].fact, trackId: `track-${i}`,
    })))));
    expect(source.tracks.size).toBeLessThanOrEqual(2);
  });

  it('limits alias bindings as well as the requests that prove them', () => {
    const { source } = make();
    source.applyBatch(decoded(batch(Array.from({ length: 16 }, (_, i) => ({
      ...snapshotFixture.facts[2].fact, requestId: String(i), trackAlias: String(i),
    })))));
    expect(source.requests.size).toBeLessThanOrEqual(2);
    expect(source.aliasBindings.size).toBeLessThanOrEqual(2);
  });

  it('limits repeated reasons retained under one delivery ID', () => {
    const { source } = make();
    const facts: Fact[] = Array.from({ length: 16 }, (_, i) => ({ kind: 'stage',
      deliveryId: 'delivery-1', unitId: `unit-${i}`, stage: 'discarded', reason: `reason-${i}` }));
    source.applyBatch(decoded(batch(facts)));
    expect(source.stages.size).toBe(1);
    expect(source.stages.get('delivery-1')?.discards.length).toBeLessThanOrEqual(2);
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects an invalid cell budget before painting: %s', cells => {
    expect(() => new ProtocolSource(() => {}, { budgets: { cells } })).toThrow();
  });

  it('rejects an unbounded retention budget independently of cell allocation', () => {
    expect(() => new ProtocolSource(() => {}, { budgets: { requests: Infinity } })).toThrow();
  });

  it('discloses dial-attempt eviction in the panel loss notice', () => {
    const { source, view } = make();
    const facts: Fact[] = Array.from({ length: 3 }, (_, i) => ({ kind: 'dial_attempt',
      attemptId: `attempt-${i}`, state: 'failed', offeredProtocols: ['moqt-22'],
      negotiatedProtocol: null, policy: 'strict' }));
    source.applyBatch(decoded(batch(facts)));
    expect(source.dialAttempts.size).toBe(2);
    expect(source.evictions.dialAttempts).toBe(1);
    expect(view().hookStats).toContain('panel evicted');
  });

  it('does not use an old session-wide metric as a current session measurement', () => {
    const { source, view } = make();
    source.applySnapshot(decoded({ ...snapshotFixture, facts: [snapshotFixture.facts[1], snapshotFixture.facts[2],
      { ...snapshotFixture.facts[0], fact: { ...snapshotFixture.facts[0].fact, sessionId: 'new-session' } },
      { ...snapshotFixture.facts[4], fact: { ...snapshotFixture.facts[4].fact, value: 999, unavailable: null } }] }));
    expect(view().sparks[0]?.now).not.toContain('999');
  });

  it('keeps run identity scoped to its source when replacing the source', () => {
    const { source, view } = make();
    source.applyBatch(decoded(batchFixture));
    source.applyBatch(decoded(gapFixture));
    expect(view().hookStats).toContain('delivery drops: 2 dense');
    const next: Snapshot = { ...snapshotFixture, target: { ...snapshotFixture.target, sourceId: 'other-source' },
      source: { ...snapshotFixture.source, sourceId: 'other-source' } };
    source.applySnapshot(decoded(next));
    expect(view().hookStats).not.toContain('delivery drops');
  });

  it('does not confuse a literal dash session ID with a source-wide metric', () => {
    const { source, view } = make();
    const snapshot: Snapshot = { ...snapshotFixture, facts: [snapshotFixture.facts[1],
      { ...snapshotFixture.facts[0], fact: { ...snapshotFixture.facts[0].fact, sessionId: '-' } },
      { ...snapshotFixture.facts[4], fact: { ...snapshotFixture.facts[4].fact, sessionId: '-', value: 10, unavailable: null } },
      { ...snapshotFixture.facts[4], fact: { ...snapshotFixture.facts[4].fact, sessionId: null, value: 999, unavailable: null } }] };
    source.applySnapshot(decoded(snapshot));
    expect(source.metrics.size).toBe(2);
    expect(view().sparks[0]?.now).toContain('10');
  });

  it('keeps displayed window bounds within the valid uint64 domain', () => {
    const { source, view } = make();
    source.applySnapshot(decoded({ ...snapshotFixture, facts: [snapshotFixture.facts[1], snapshotFixture.facts[2],
      { ...snapshotFixture.facts[3], fact: { ...snapshotFixture.facts[3].fact, objectId: '18446744073709551615' } }] }));
    expect(BigInt(view().rows[0]!.window.to)).toBeLessThanOrEqual(18446744073709551615n);
  });
});
