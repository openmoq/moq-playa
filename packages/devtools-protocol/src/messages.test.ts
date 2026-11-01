import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from './index.js';
import type { KnownFact, Message } from './index.js';
import { batchFixture, failureFixture, fixtureTarget, helloFixture, snapshotFixture } from './fixtures.js';

const common = { channel: 'openmoq-devtools', version: { major: 1, minor: 0 },
  requestId: 'command-1', target: fixtureTarget } as const;
const commands = {
  discover: { ...common, kind: 'discover', ownerId: fixtureTarget.ownerId },
  hello: helloFixture,
  attach: { ...common, kind: 'attach' },
  'snapshot.request': { ...common, kind: 'snapshot.request', scope: { kind: 'source' } },
  snapshot: snapshotFixture,
  batch: batchFixture,
  detach: { ...common, kind: 'detach' },
  'record.start': { ...common, kind: 'record.start' },
  'record.started': { ...common, kind: 'record.started', recordingId: 'record-1', token: 'test-token' },
  'record.stop': { ...common, kind: 'record.stop', recordingId: 'record-1', token: 'test-token' },
  'record.export': { ...common, kind: 'record.export', recordingId: 'record-1', token: 'test-token' },
  'export.chunk': { ...common, kind: 'export.chunk', exportId: 'export-1', index: 0, final: true, data: 'trace' },
  ack: { ...common, kind: 'ack' },
  error: { ...common, kind: 'error', code: 'not-owner', message: 'Another attachment owns this recording' },
} as const satisfies { [K in Message['kind']]: Extract<Message, { kind: K }> };

const facts = {
  session: snapshotFixture.facts[0].fact,
  track: snapshotFixture.facts[1].fact,
  request: snapshotFixture.facts[2].fact,
  object: snapshotFixture.facts[3].fact,
  stage: { kind: 'stage', deliveryId: 'delivery-1', unitId: null, stage: 'appended', reason: null },
  group_bound: { kind: 'group_bound', sessionId: 'session-1', trackAlias: '100', groupId: '0',
    objectId: '60', bound: 'exclusive', evidence: 'end-of-group' },
  group_summary: { kind: 'group_summary', sessionId: 'session-1', trackAlias: '100', groupId: '0',
    observedObjects: '12', observedBytes: '6000', completeCapture: false },
  control: { kind: 'control', sessionId: 'session-1', streamId: '4', requestId: '2',
    messageType: 'SUBSCRIBE_OK', direction: 'received' },
  stream: { kind: 'stream', sessionId: 'session-1', streamId: '6', trackAlias: '100', groupId: '0',
    subgroupId: '0', state: 'fin', code: null },
  metric: snapshotFixture.facts[4].fact,
  failure: failureFixture.events[0].fact,
  dial_attempt: { kind: 'dial_attempt', attemptId: 'attempt-1', state: 'started',
    offeredProtocols: ['moqt-22'], negotiatedProtocol: null, policy: 'strict' },
  recording: { kind: 'recording', recordingId: 'record-1', ownerAttachmentId: 'attachment-1', state: 'recording' },
  source_state: { kind: 'source_state', state: 'ended', reason: 'disposed' },
} as const satisfies { [K in KnownFact['kind']]: Extract<KnownFact, { kind: K }> };

describe('command and evidence projections', () => {
  it.each(Object.values(commands))('roundtrips the $kind message', message => {
    const encoded = encodeMessage(message);
    const result = decodeMessage(encoded);
    expect(result.ok).toBe(true);
    if (result.ok) expect(encodeMessage(result.message)).toBe(encoded);
  });

  it.each(Object.values(facts))('retains the $kind fact', fact => {
    const batch: Message = { ...batchFixture, events: [{ ...batchFixture.events[0], fact }] };
    expect(decodeMessage(encodeMessage(batch))).toEqual({ ok: true, message: batch });
  });

  it('never treats subgroup FIN as a group bound or object total', () => {
    const batch = { ...batchFixture, events: [{ ...batchFixture.events[0], fact: facts.stream }] };
    const result = decodeMessage(encodeMessage(batch));
    expect(result).toEqual({ ok: true, message: batch });
    expect(JSON.stringify(result)).not.toMatch(/group_bound|observedObjects|totalObjects/);
  });

  it('can report a future draft without claiming to implement its wire protocol', () => {
    const batch: Message = { ...batchFixture,
      events: [{ ...batchFixture.events[0], fact: { ...facts.session, draft: 23 } }] };
    expect(decodeMessage(encodeMessage(batch))).toEqual({ ok: true, message: batch });
  });

  it.each(['record.stop', 'record.export'] as const)('%s requires the recording owner token', kind => {
    const { token: _token, ...missing } = commands[kind];
    expect(decodeMessage(JSON.stringify(missing)).ok).toBe(false);
    expect(decodeMessage(encodeMessage(commands[kind])).ok).toBe(true);
  });

  it('does not publish an owner token in shared recording state', () => {
    const batch = { ...batchFixture, events: [{ ...batchFixture.events[0],
      fact: { ...facts.recording, token: 'secret-owner-token' } }] };
    expect(encodeMessage(batch)).not.toContain('secret-owner-token');
  });

  it('rejects a sequence-zero batch without preventing the initial empty snapshot', () => {
    expect(decodeMessage(encodeMessage({ ...snapshotFixture, watermark: '0', facts: [] })).ok).toBe(true);
    expect(decodeMessage(JSON.stringify({ ...batchFixture, fromSeq: '0', toSeq: '0',
      events: [{ ...batchFixture.events[0], seq: '0' }] })).ok).toBe(false);
  });
});
