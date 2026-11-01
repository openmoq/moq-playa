import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage, MAX_MESSAGE_BYTES, sameTarget } from './index.js';
import type { Message } from './index.js';
import { batchFixture, failureFixture, fixtureTarget, helloFixture, protocolFixtures, snapshotFixture } from './fixtures.js';

const wire = (value: unknown) => JSON.stringify(value);

describe('DevTools diagnostic boundary', () => {
  it.each(protocolFixtures)('accepts the shared $kind fixture through JSON', (fixture) => {
    expect(decodeMessage(wire(fixture))).toMatchObject({ ok: true, message: fixture });
  });

  it('accepts a newer additive minor and removes unknown fields', () => {
    expect(decodeMessage(wire({ ...helloFixture, version: { major: 1, minor: 2 }, futureField: 'ignored' })))
      .toEqual({ ok: true, message: { ...helloFixture, version: { major: 1, minor: 2 } } });
  });

  it('refuses a different major before interpreting its payload', () => {
    expect(decodeMessage(wire({ ...helloFixture, version: { major: 2, minor: 0 }, sources: null })))
      .toMatchObject({ ok: false, error: { code: 'incompatible-version' } });
  });

  it('rejects oversized input before parsing', () => {
    expect(decodeMessage(' '.repeat(MAX_MESSAGE_BYTES + 1)))
      .toMatchObject({ ok: false, error: { code: 'too-large' } });
  });

  it('counts UTF-8 bytes rather than UTF-16 characters', () => {
    const input = wire({ ...helloFixture, future: '€'.repeat(90000) });
    expect(input.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(decodeMessage(input)).toMatchObject({ ok: false, error: { code: 'too-large' } });
  });

  it('rejects invalid JSON without throwing', () => {
    expect(decodeMessage('{')).toMatchObject({ ok: false, error: { code: 'invalid-json' } });
  });

  it('preserves group IDs above the safe-integer limit', () => {
    expect(decodeMessage(wire(batchFixture))).toMatchObject({ ok: true,
      message: { events: [{ fact: { groupId: '9007199254740993' } }] } });
  });

  it.each([9007199254740993, '01', '-1', '18446744073709551616'])('rejects a lossy/noncanonical ID: %s', (groupId) => {
    const event = batchFixture.events[0];
    expect(decodeMessage(wire({ ...batchFixture, events: [{ ...event, fact: { ...event.fact, groupId } }] })).ok).toBe(false);
  });

  it('retains exact byte-field boundaries including slash and empty name', () => {
    const first = snapshotFixture.facts[1];
    const identity = { namespace: ['6c6976652f73686f77'], name: '' };
    expect(decodeMessage(wire({ ...snapshotFixture, facts: [{ ...first, fact: { ...first.fact, identity } }] })))
      .toMatchObject({ ok: true, message: { facts: [{ fact: { identity } }] } });
  });

  it.each(['ABC0', '0', 'zz'])('rejects noncanonical byte encoding: %s', (name) => {
    const first = snapshotFixture.facts[1];
    expect(decodeMessage(wire({ ...snapshotFixture, facts: [{ ...first,
      fact: { ...first.fact, identity: { namespace: [], name } } }] })).ok).toBe(false);
  });

  it('normalizes an unexposed subprotocol without filling it from the offer', () => {
    const first = snapshotFixture.facts[0];
    expect(decodeMessage(wire({ ...snapshotFixture, facts: [{ ...first,
      fact: { ...first.fact, negotiatedProtocol: '' } }] })))
      .toMatchObject({ ok: true, message: { facts: [{ fact: { negotiatedProtocol: null, offeredProtocols: ['moqt-18'] } }] } });
  });

  it.each([18, 22])('does not accept a MAX_REQUEST_ID value on draft %s', (draft) => {
    const first = snapshotFixture.facts[0];
    expect(decodeMessage(wire({ ...snapshotFixture, facts: [{ ...first,
      fact: { ...first.fact, draft, maxRequestId: { value: '100', unavailable: null } } }] })).ok).toBe(false);
  });

  it('keeps generic dial failures unattributed', () => {
    expect(decodeMessage(wire(failureFixture))).toMatchObject({ ok: true,
      message: { events: [{ fact: { stage: 'dial', attribution: 'unknown', code: null } }] } });
  });

  it('does not retain unknown credential/payload fields in known observations', () => {
    const event = batchFixture.events[0];
    const result = decodeMessage(wire({ ...batchFixture, events: [{ ...event,
      fact: { ...event.fact, authorization: 'secret-token', payload: 'secret-media' } }] }));
    expect(result.ok).toBe(true);
    expect(wire(result)).not.toMatch(/secret-token|secret-media|authorization/);
  });

  it('skips an unknown additive fact without retaining its payload or losing sequence', () => {
    expect(decodeMessage(wire({ ...batchFixture, events: [{ ...batchFixture.events[0],
      fact: { kind: 'future_fact', payload: 'do-not-retain' } }] })))
      .toMatchObject({ ok: true, message: { events: [{ seq: '6', fact: { kind: 'unknown', name: 'future_fact' } }] } });
  });

  it('can forward an unknown fact without changing its name or keeping its payload', () => {
    const result = decodeMessage(wire({ ...batchFixture, events: [{ ...batchFixture.events[0],
      fact: { kind: 'future_fact', payload: 'secret-media' } }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeMessage(encodeMessage(result.message))).toEqual(result);
    expect(encodeMessage(result.message)).not.toContain('secret-media');
  });

  it('projects extra fields out of producer messages as well as received messages', () => {
    const message = { ...batchFixture, authorization: 'secret-token' };
    expect(encodeMessage(message)).toBe(wire(batchFixture));
  });

  it('rejects a numeric overflow instead of serializing it as an unavailable metric', () => {
    const metric = snapshotFixture.facts[4];
    const message: Message = { ...snapshotFixture, facts: [{ ...metric,
      fact: { ...metric.fact, value: Infinity } }] };
    expect(() => encodeMessage(message)).toThrow();
  });

  it.each([
    { value: 0, unavailable: null, accepted: true },
    { value: null, unavailable: 'not-observed', accepted: true },
    { value: 0, unavailable: 'unsupported', accepted: false },
    { value: null, unavailable: null, accepted: false },
  ])('distinguishes a measured zero from unavailable data: %j', ({ value, unavailable, accepted }) => {
    const metric = snapshotFixture.facts[4];
    expect(decodeMessage(wire({ ...snapshotFixture, facts: [{ ...metric,
      fact: { ...metric.fact, value, unavailable } }] })).ok).toBe(accepted);
  });

  it('supports a bounded, explicitly incomplete group snapshot', () => {
    const scope = { kind: 'group', sessionId: 'session-1', trackAlias: '100', groupId: '9007199254740993' };
    const message = { ...snapshotFixture, scope, omittedFacts: 3 };
    expect(decodeMessage(wire(message))).toMatchObject({ ok: true, message });
    expect(decodeMessage(wire({ ...message, kind: 'snapshot.request' })))
      .toMatchObject({ ok: true, message: { scope } });
  });

  it('does not accept a group scope without its session identity', () => {
    expect(decodeMessage(wire({ ...snapshotFixture,
      scope: { kind: 'group', trackAlias: '100', groupId: '0' } })).ok).toBe(false);
  });

  it.each([
    { source: { ...snapshotFixture.source, runId: 'other-run' } },
    { clocks: [snapshotFixture.clocks[0], snapshotFixture.clocks[0]] },
    { clocks: [] },
    { retention: { ...snapshotFixture.retention, retainedEvents: 1001 } },
  ])('rejects inconsistent snapshot metadata %#', (change) => {
    expect(decodeMessage(wire({ ...snapshotFixture, ...change })).ok).toBe(false);
  });

  it.each([
    { fromSeq: '7', toSeq: '6' },
    { fromSeq: '5', toSeq: '6' },
    { dropped: { dense: '1', sparse: '0' } },
    { events: [batchFixture.events[0], batchFixture.events[0]] },
  ])('rejects inconsistent batch accounting %#', (change) => {
    expect(decodeMessage(wire({ ...batchFixture, ...change })).ok).toBe(false);
  });

  it.each(['ownerId', 'sourceId', 'runId', 'attachmentId'] as const)('cannot route across a different %s', (field) => {
    expect(sameTarget(fixtureTarget, { ...fixtureTarget, [field]: 'successor' })).toBe(false);
    expect(sameTarget(fixtureTarget, { ...fixtureTarget })).toBe(true);
  });

  it('does not add probe start to the page-facing message vocabulary', () => {
    expect(decodeMessage(wire({ ...helloFixture, kind: 'probe.start', url: 'https://example.test' })).ok).toBe(false);
  });
});
