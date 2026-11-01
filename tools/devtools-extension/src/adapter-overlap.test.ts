import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '@openmoq/devtools-protocol';
import { snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import type { Observation } from '@openmoq/devtools-protocol';
import { ProtocolSource } from './adapter.js';

// Overlapping connections and alias reuse are already supported by the model (session-scoped keys); these tests pin
// that the VISIBLE rows disambiguate them without merging identities, and that a single session stays compact.
const sourceFrom = (facts: readonly Observation[], budgets?: ConstructorParameters<typeof ProtocolSource>[1]) => {
  const decoded = decodeMessage(encodeMessage({ ...snapshotFixture, facts }));
  if (!decoded.ok || decoded.message.kind !== 'snapshot') throw new Error('fixture rejected');
  const source = new ProtocolSource(() => {}, budgets);
  source.applySnapshot(decoded.message);
  return source;
};
const [session, , request, object] = snapshotFixture.facts;
const overlapping = () => sourceFrom([...snapshotFixture.facts,
  { ...session!, fact: { ...session!.fact, sessionId: 'replacement-session' } },
  { ...request!, fact: { ...request!.fact, sessionId: 'replacement-session' } },
  { ...object!, fact: { ...object!.fact, sessionId: 'replacement-session', deliveryId: 'replacement-delivery' } }]);

describe('overlapping sessions and reused ids stay distinguishable on screen', () => {
  it('names the owning session on request rows when two sessions reuse one request id and track', () => {
    const vm = overlapping().build();
    expect(vm.requests).toHaveLength(2);
    expect(new Set(vm.requests.map(r => [r.id, r.track, r.label, r.context].join('|'))).size).toBe(2);
    expect(vm.requests.map(r => r.context).sort()).toEqual(['session replacement-session', 'session session-1']);
  });
  it('names session and alias on group rows when two sessions reuse group, alias and track; the selectCell key is unchanged', () => {
    const vm = overlapping().build();
    expect(vm.rows).toHaveLength(2);
    expect(vm.rows[0]!.cells[0]!.g).not.toBe(vm.rows[1]!.cells[0]!.g);
    expect(vm.rows.map(r => r.cells[0]!.g).sort()).toEqual(['replacement-session/100/9007199254740993', 'session-1/100/9007199254740993']);
    expect(new Set(vm.rows.map(r => [r.label, r.meta, r.context].join('|'))).size).toBe(2);
    expect(vm.rows.map(r => r.context).sort()).toEqual(['session replacement-session · alias 100', 'session session-1 · alias 100']);
  });
  it('distinguishes two aliases for the same track and group within one session, in rows and in the selected object', () => {
    const source = sourceFrom([...snapshotFixture.facts,
      { ...request!, fact: { ...request!.fact, requestId: '4', trackAlias: '101' } },
      { ...object!, fact: { ...object!.fact, requestId: '4', trackAlias: '101', deliveryId: 'second-alias-delivery' } }]);
    const vm = source.build();
    expect(vm.rows).toHaveLength(2);
    expect(vm.rows.map(r => r.context).sort()).toEqual(['session session-1 · alias 100', 'session session-1 · alias 101']);
    expect(vm.requests.every(r => r.context === null)).toBe(true);   // one session: request ids are unambiguous
    source.selectCell('session-1/101/9007199254740993', '0');
    const selected = Object.fromEntries(source.build().selected.map(([k, v]) => [k, v]));
    expect(selected).toMatchObject({ selected: 'g9007199254740993 / o0', session: 'session-1', alias: '101' });
  });
  it('pairs the header with the displayed session identity', () => {
    const single = Object.fromEntries(sourceFrom(snapshotFixture.facts).build().session.map(([k, v]) => [k, v]));
    expect(single.session).toBe('session-1');
    const multi = Object.fromEntries(overlapping().build().session.map(([k, v]) => [k, v]));
    expect(multi.session).toBe('replacement-session (latest of 2 retained)');
  });
  it('keeps request ownership labels after session METADATA is evicted independently (budget sessions: 1)', () => {
    const source = sourceFrom([...snapshotFixture.facts,
      { ...session!, fact: { ...session!.fact, sessionId: 'replacement-session' } },
      { ...request!, fact: { ...request!.fact, sessionId: 'replacement-session' } }], { budgets: { sessions: 1 } });
    expect(source.sessions.size).toBe(1);
    expect(source.evictions.sessions).toBe(1);
    const requests = source.build().requests;
    expect(requests).toHaveLength(2);
    expect(requests.map(r => r.context).sort()).toEqual(['session replacement-session', 'session session-1']);
  });
  it('CONTROL: a single session with one alias adds no ownership text anywhere', () => {
    const source = sourceFrom(snapshotFixture.facts);
    const vm = source.build();
    expect(vm.requests.every(r => r.context === null)).toBe(true);
    expect(vm.rows.every(r => r.context === null)).toBe(true);
    source.selectCell(vm.rows[0]!.cells[0]!.g, '0');
    expect(source.build().selected.map(([k]) => k)).toEqual(['selected', 'arrival offset', 'size', 'stream', 'status']);
  });
});
