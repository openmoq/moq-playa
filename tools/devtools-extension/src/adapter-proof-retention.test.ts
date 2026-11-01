/**
 * Alias proof retirement and bounded control kinds. A (session, alias) → track
 * binding lives exactly as long as a RETAINED request proves it; evicting the
 * sole proof removes the binding, and a later unidentified object stays
 * unattributed. The control-kind table is bounded including its overflow
 * bucket, with the event total preserved.
 */
import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '@openmoq/devtools-protocol';
import type { Batch, Fact, Message } from '@openmoq/devtools-protocol';
import { batchFixture, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { ProtocolSource } from './adapter.js';

function decoded<T extends Message>(value: T): T {
  const result = decodeMessage(encodeMessage(value));
  if (!result.ok) throw new Error(result.error.code);
  return result.message as T;
}
function batch(facts: readonly Fact[], from = 6): Batch {
  return { ...batchFixture, fromSeq: String(from), toSeq: String(from + facts.length - 1),
    events: facts.map((fact, i) => ({ seq: String(from + i), clockId: 'mock-clock', timeMs: 10 + i, fact })) };
}
function source(requests = 1) {
  const s = new ProtocolSource(() => {}, { budgets: { requests, aliases: 8, controlKinds: 2 } });
  s.applySnapshot(decoded({ ...snapshotFixture, facts: snapshotFixture.facts.slice(0, 3) }));
  return s;
}
const request = snapshotFixture.facts[2].fact;

describe('alias proof retirement', () => {
  it('removes the binding when its sole proving request leaves retention', () => {
    const s = source();
    s.applyBatch(decoded(batch([{ ...request, requestId: '4', trackAlias: null, trackId: null }])));
    expect(s.requests.has('session-1/2')).toBe(false);
    expect(s.aliasBindings.has('session-1/100')).toBe(false);
  });

  it('does not attribute a later unidentified object using an evicted proof', () => {
    const s = source();
    s.applyBatch(decoded(batch([
      { ...request, requestId: '4', trackAlias: null, trackId: null },
      { ...snapshotFixture.facts[3].fact, trackId: null },
    ])));
    expect(s.groups.size).toBe(1);
    expect(s.build().rows).toHaveLength(0);
  });

  it('keeps the binding when another retained request still proves it', () => {
    const s = source(2);
    s.applyBatch(decoded(batch([
      { ...request, requestId: '4' },
      { ...request, requestId: '6', trackAlias: null, trackId: null },
      { ...snapshotFixture.facts[3].fact, trackId: null },
    ])));
    expect(s.requests.has('session-1/2')).toBe(false);
    expect(s.aliasBindings.get('session-1/100')).toBe('video-1');
    expect(s.build().rows).toHaveLength(1);
  });

  it('keeps an explicitly identified object visible after request eviction', () => {
    const s = source();
    s.applyBatch(decoded(batch([
      { ...request, requestId: '4', trackAlias: null, trackId: null },
      snapshotFixture.facts[3].fact,
    ])));
    expect(s.build().rows).toHaveLength(1);
  });
});

it('keeps the overflow control counter inside its configured total budget', () => {
  const s = source();
  s.applyBatch(decoded(batch(['SUBSCRIBE', 'SUBSCRIBE_OK', 'GOAWAY'].map(messageType => ({
    kind: 'control', sessionId: 'session-1', streamId: null, requestId: null, direction: 'received', messageType,
  })))));
  expect(s.controlCounts.size).toBeLessThanOrEqual(2);
  expect([...s.controlCounts.values()].reduce((sum, n) => sum + n, 0)).toBe(3);
});
