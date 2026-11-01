import { describe, expect, it, vi } from 'vitest';
import { advanceCursor, cursorFromSnapshot, decodeMessage, encodeMessage, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import type { AttachmentTarget, Message, Snapshot } from '@openmoq/devtools-protocol';
import { fixtureSource, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { DiagnosticCapture } from './capture.js';
import { DiagnosticRegistry } from './registry.js';
import type { DiagnosticHostConnection } from './registry.js';

const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
const target = { ownerId: 'owner', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId };
const discover = (ownerId = 'owner'): Message => ({ ...common, kind: 'discover', ownerId, requestId: 'discover' });
const attach = (overrides = {}): Message => ({ ...common, kind: 'attach', requestId: 'attach', target: { ...target, ...overrides } });
function messages(frames: readonly string[]): Message[] {
  return frames.map(frame => {
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const result = decodeMessage(frame);
    if (!result.ok) throw new Error('Invalid reply');
    return result.message;
  });
}
function send(conn: DiagnosticHostConnection, message: Message): Message[] { return messages(conn.request(encodeMessage(message))); }
function bind(conn: DiagnosticHostConnection, overrides = {}): Snapshot {
  const [response] = send(conn, attach(overrides));
  expect(response?.kind).toBe('snapshot');
  if (response?.kind !== 'snapshot') throw new Error('Expected initial snapshot');
  return response;
}
function capture(overrides: Partial<ConstructorParameters<typeof DiagnosticCapture>[0]> = {}) {
  const now = vi.fn(() => 10);
  const activity = vi.fn();
  const source = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached', capabilities: ['objects'] },
    clock: { id: 'clock', now }, onActiveChange: activity, ...overrides });
  return { source, now, activity };
}
function command(kind: 'snapshot.request' | 'detach', target: AttachmentTarget): Message {
  return kind === 'detach' ? { ...common, kind, requestId: 'detach', target }
    : { ...common, kind, requestId: 'refresh', target, scope: { kind: 'source' } };
}

describe('explicit page diagnostic registry', () => {
  it('discovers copied descriptors without activating capture or reading clocks', () => {
    const r = new DiagnosticRegistry(); const c = capture();
    r.register(c.source);
    const descriptor = c.source.descriptor;
    // @ts-expect-error Public metadata is readonly, and runtime mutation of this copy must be harmless.
    descriptor.label = 'mutated';
    // @ts-expect-error Nested metadata is readonly too.
    descriptor.capabilities.push('stolen');
    const owner = r.open('owner');
    expect(send(owner, discover())).toMatchObject([{ kind: 'hello', requestId: 'discover', ownerId: 'owner',
      sources: [{ label: fixtureSource.label, capabilities: ['objects'] }] }]);
    expect(c.now).not.toHaveBeenCalled(); expect(c.activity).not.toHaveBeenCalled();
    expect(owner.pull()).toBeNull();
  });

  it('routes one attachment and its refresh in order through the public codec/cursor', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    c.source.emit(snapshotFixture.facts[3].fact, 'dense');
    const frames = send(owner, command('snapshot.request', initial.target));
    expect(frames.map(f => f.kind)).toEqual(['batch', 'snapshot']);
    if (frames[0]?.kind !== 'batch' || frames[1]?.kind !== 'snapshot') throw new Error('Expected refresh');
    expect(advanceCursor(cursorFromSnapshot(initial), frames[0]).kind).toBe('accept');
    expect(frames[1].watermark).toBe(frames[0].toSeq);
    expect(owner.pull()).toBeNull();
    c.source.emit(snapshotFixture.facts[3].fact, 'dense');
    const frame = owner.pull(); expect(frame).not.toBeNull();
    expect(messages([frame!])).toMatchObject([{ kind: 'batch', fromSeq: '2' }]);
    expect(send(owner, command('detach', initial.target))).toMatchObject([{ kind: 'ack', requestId: 'detach', target: initial.target }]);
    expect(c.source.active).toBe(false); expect(owner.closed).toBe(false);
  });

  it('refuses implicit replacement and lets an explicit detach precede a new lease', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    expect(send(owner, attach())).toMatchObject([{ kind: 'error', code: 'invalid-state' }]);
    expect(c.activity).toHaveBeenCalledExactlyOnceWith(true);
    send(owner, command('detach', initial.target));
    const replacement = bind(owner);
    expect(replacement.target.attachmentId).not.toBe(initial.target.attachmentId);
    expect(send(owner, command('detach', initial.target))).toMatchObject([{ kind: 'error', code: 'not-found' }]);
    expect(c.source.active).toBe(true);
  });

  it('binds authority to connection objects and checks every target component', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    const other = r.open('other');
    expect(send(other, discover())).toMatchObject([{ kind: 'error', code: 'not-owner' }]);
    expect(send(other, attach())).toMatchObject([{ kind: 'error', code: 'not-owner' }]);
    expect(send(other, command('detach', initial.target))).toMatchObject([{ kind: 'error', code: 'not-owner' }]);
    for (const field of ['sourceId', 'runId', 'attachmentId'] as const) {
      const wrong = { ...initial.target, [field]: 'wrong' };
      expect(send(owner, command('snapshot.request', wrong))).toMatchObject([{ kind: 'error', code: 'not-found' }]);
      expect(send(owner, command('detach', wrong))).toMatchObject([{ kind: 'error', code: 'not-found' }]);
    }
    expect(c.source.active).toBe(true);
    expect(send(owner, command('snapshot.request', initial.target))[0]?.kind).toBe('snapshot');
  });

  it('keeps duplicate active owners out without closing the original, and old handles stay inert', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); bind(owner);
    expect(() => r.open('owner')).toThrow(/owner/);
    expect(owner.closed).toBe(false); expect(c.source.active).toBe(true);
    owner.close(); owner.close();
    expect(owner.closedReason).toBe('owner-closed');
    const next = r.open('owner'); bind(next);
    expect(owner.request(encodeMessage(discover()))).toEqual([]);
    expect(owner.pull()).toBeNull(); owner.close();
    expect(next.closed).toBe(false); expect(c.source.active).toBe(true);
  });

  it('revokes only the removed source and forbids source/run reuse without ending the application capture', () => {
    const r = new DiagnosticRegistry(); const c = capture(); const remove = r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    remove(); remove();
    expect(send(owner, discover())).toMatchObject([
      { kind: 'error', requestId: 'attach', target: initial.target, code: 'not-found' }, { sources: [] },
    ]);
    expect(send(owner, command('snapshot.request', initial.target))).toMatchObject([{ kind: 'error', code: 'not-found' }]);
    expect(owner.pull()).toBeNull();
    expect(c.source.active).toBe(false);
    const app = c.source.attach('application', 'app');
    expect(c.source.active).toBe(true); app.lease.close();
    expect(() => r.register(c.source)).toThrow(/identity/);
    const next = capture({ source: { ...c.source.descriptor, runId: 'run-2' } });
    r.register(next.source); remove();
    expect(send(owner, discover())).toMatchObject([{ sources: [{ runId: 'run-2' }] }]);
    expect(() => bind(owner, { runId: 'run-2' })).not.toThrow();
  });

  it('unregistering one source leaves a different source and owner attached', () => {
    const r = new DiagnosticRegistry(); const a = capture(); const remove = r.register(a.source);
    const b = capture({ source: { ...a.source.descriptor, sourceId: 'b' } }); r.register(b.source);
    bind(r.open('owner'));
    const other = r.open('other'); bind(other, { ownerId: 'other', sourceId: 'b' });
    remove();
    expect(a.source.active).toBe(false); expect(b.source.active).toBe(true);
    b.source.emit(snapshotFixture.facts[3].fact, 'dense'); expect(other.pull()).not.toBeNull();
  });

  it('delivers withdrawal once through pull using the original attach correlation, without ending capture', () => {
    const r = new DiagnosticRegistry(); const c = capture(); const remove = r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    c.source.emit(snapshotFixture.facts[3].fact, 'dense');
    remove();
    const frame = owner.pull(); expect(frame).not.toBeNull();
    expect(messages([frame!])).toMatchObject([{ kind: 'error', code: 'not-found', requestId: 'attach', target: initial.target }]);
    expect(frame).not.toContain('source_state'); expect(owner.pull()).toBeNull();
    expect(owner.closed).toBe(false);
    const app = c.source.attach('app', 'app'); app.lease.close();
  });

  it('delivers a queued withdrawal before a replacement attach snapshot, without losing it on an intervening wrong-owner request', () => {
    const r = new DiagnosticRegistry(); const c = capture(); const remove = r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner); remove();
    expect(send(owner, discover('other'))).toMatchObject([{ kind: 'error', code: 'not-owner' }]);
    const next = capture({ source: { ...c.source.descriptor, runId: 'run-2' } }); r.register(next.source);
    expect(send(owner, attach({ runId: 'run-2' }))).toMatchObject([
      { kind: 'error', requestId: 'attach', target: initial.target, code: 'not-found' },
      { kind: 'snapshot', target: { runId: 'run-2' } },
    ]);
    expect(owner.pull()).toBeNull(); expect(next.source.active).toBe(true);
  });

  it('returns unsupported for recording without invoking another action or reflecting a token', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    for (const kind of ['record.start', 'record.stop', 'record.export'] as const) {
      const message: Message = kind === 'record.start' ? { ...common, kind, requestId: 'record', target: initial.target }
        : { ...common, kind, requestId: 'record', target: initial.target, recordingId: 'recording', token: 'secret-token' };
      const result = owner.request(encodeMessage(message));
      expect(messages(result)).toMatchObject([{ kind: 'error', code: 'unsupported' }]);
      expect(result.join('')).not.toContain('secret-token');
    }
    expect(c.source.active).toBe(true); expect(c.activity).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'non-text', input: null }, { name: 'missing fields', input: '{}' },
    { name: 'invalid JSON', input: 'secret-token' }, { name: 'oversize', input: 'x'.repeat(MAX_MESSAGE_BYTES + 1) },
  ])('closes malformed input without echoing it ($name)', ({ input }) => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); bind(owner);
    expect(owner.request(input)).toEqual([]);
    expect(owner.closedReason).toBe('invalid-message'); expect(c.source.active).toBe(false);
    expect(owner.request(encodeMessage(discover()))).toEqual([]);
  });

  it('rejects replies presented as commands and does not pretend the source ended', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    expect(owner.request(encodeMessage(initial))).toEqual([]);
    expect(owner.closedReason).toBe('unexpected-message');
    const next = r.open('next'); expect(bind(next, { ownerId: 'next' }).facts).toEqual([]);
  });

  it('preserves terminal capture facts while the registry connection remains open', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    const owner = r.open('owner'); const initial = bind(owner);
    c.source.dispose();
    const frames = send(owner, command('snapshot.request', initial.target));
    expect(frames.map(f => f.kind)).toEqual(['batch', 'snapshot']);
    expect(frames[0]).toMatchObject({ events: [{ fact: { kind: 'source_state' } }] });
    expect(owner.closed).toBe(false);
    send(owner, command('detach', initial.target));
    expect(send(owner, attach())).toMatchObject([{ kind: 'error', code: 'invalid-state' }]);
  });

  it('sanitizes source errors and keeps a refusal from orphaning the connection', () => {
    const r = new DiagnosticRegistry(); const c = capture(); r.register(c.source);
    vi.spyOn(c.source, 'attach').mockImplementation(() => { throw new Error('CAT-token TOP-SECRET'); });
    const owner = r.open('owner'); const result = owner.request(encodeMessage(attach()));
    expect(messages(result)).toMatchObject([{ kind: 'error', code: 'invalid-state' }]);
    expect(result.join('')).not.toContain('TOP-SECRET'); expect(owner.closed).toBe(false);
  });

  it('fences unregister during activation and releases the just-created orphan lease', () => {
    const r = new DiagnosticRegistry(); let remove!: () => void;
    const c = capture({ onActiveChange: active => { if (active) remove(); } });
    remove = r.register(c.source); const owner = r.open('owner');
    expect(send(owner, attach())).toMatchObject([{ kind: 'error', code: 'not-found' }]);
    expect(c.source.active).toBe(false); expect(owner.closed).toBe(false);
  });

  it('fences owner close during activation and never sends its late snapshot', () => {
    const r = new DiagnosticRegistry(); let owner!: DiagnosticHostConnection;
    const c = capture({ onActiveChange: active => { if (active) owner.close(); } });
    r.register(c.source); owner = r.open('owner');
    expect(send(owner, attach())).toEqual([]);
    expect(c.source.active).toBe(false); expect(owner.closedReason).toBe('owner-closed');
  });

  it('closes a reentrant command owner without corrupting a newer lease', () => {
    const r = new DiagnosticRegistry(); let owner!: DiagnosticHostConnection;
    const c = capture({ onActiveChange: active => { if (active) owner.request(encodeMessage(discover())); } });
    r.register(c.source); owner = r.open('owner');
    expect(send(owner, attach())).toEqual([]);
    expect(owner.closedReason).toBe('reentrant-request'); expect(c.source.active).toBe(false);
  });

  it('rechecks source ownership after a refresh invokes the clock', () => {
    const r = new DiagnosticRegistry(); let revoke = false; let remove!: () => void;
    const c = capture({ clock: { id: 'clock', now: () => { if (revoke) remove(); return 1; } } });
    remove = r.register(c.source); const owner = r.open('owner'); const initial = bind(owner);
    revoke = true;
    expect(send(owner, command('snapshot.request', initial.target))).toMatchObject([{ kind: 'error', code: 'not-found' }]);
    expect(messages([owner.pull()!])).toMatchObject([{ kind: 'error', code: 'not-found', requestId: 'attach', target: initial.target }]);
    expect(owner.pull()).toBeNull();
    expect(c.source.active).toBe(false);
  });

  it('revokes all registry connections before callbacks can reopen the disposed registry', () => {
    const r = new DiagnosticRegistry(); const refused = vi.fn();
    const c = capture({ onActiveChange: active => { if (!active) { expect(() => r.open('new')).toThrow(/disposed/); refused(); } } });
    r.register(c.source); const owner = r.open('owner'); bind(owner);
    r.dispose(); r.dispose();
    expect(owner.closedReason).toBe('registry-disposed'); expect(refused).toHaveBeenCalledTimes(1);
    expect(() => r.register(c.source)).toThrow(/disposed/); expect(c.source.active).toBe(false);
    const app = c.source.attach('app', 'app'); app.lease.close();
  });

  it('bounds active sources, metadata, connections and retired identity memory', () => {
    const r = new DiagnosticRegistry({ limits: { maxSources: 1, maxConnections: 1, maxRegistrations: 2 } });
    const c = capture(); const remove = r.register(c.source); const owner = r.open('owner');
    const b = capture({ source: { ...c.source.descriptor, sourceId: 'b' } });
    expect(() => r.register(b.source)).toThrow(/limit/);
    expect(() => r.open('other')).toThrow(/limit/);
    owner.close(); expect(() => r.open('other')).not.toThrow();
    remove(); const removeB = r.register(b.source); removeB();
    const d = capture({ source: { ...c.source.descriptor, sourceId: 'd' } });
    expect(() => r.register(d.source)).toThrow(/limit/);
    const byteLimited = new DiagnosticRegistry({ limits: { maxDescriptorBytes: 100 } });
    expect(() => byteLimited.register(c.source)).toThrow(/limit/);
  });

  it('keeps aggregate discovery replies decodable under the shared wire limit', () => {
    const r = new DiagnosticRegistry({ limits: { maxSources: 64, maxDescriptorBytes: MAX_MESSAGE_BYTES - 2048 } });
    for (let i = 0; i < 64; i++) {
      const c = capture({ source: { ...fixtureSource, kind: 'attached', sourceId: `s-${i}`, label: '🟡'.repeat(1024) } });
      try { r.register(c.source); } catch (error) { expect(String(error)).toMatch(/limit/); }
    }
    const [hello] = send(r.open('owner'), discover());
    expect(hello?.kind).toBe('hello');
    if (hello?.kind !== 'hello') throw new Error('Expected hello');
    expect(hello.sources.length).toBeGreaterThan(1); expect(hello.sources.length).toBeLessThan(64);
  });

  it('keeps probe sources out of page discovery', () => {
    const r = new DiagnosticRegistry(); const c = capture({ source: fixtureSource });
    expect(() => r.register(c.source)).toThrow(/attached/);
    expect(send(r.open('owner'), discover())).toMatchObject([{ sources: [] }]);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid limits %s', value => {
    for (const key of ['maxSources', 'maxDescriptorBytes', 'maxConnections', 'maxRegistrations']) {
      expect(() => new DiagnosticRegistry({ limits: { [key]: value } })).toThrow();
    }
  });

  it('rejects source-count and aggregate-byte limits beyond the wire ceiling', () => {
    expect(() => new DiagnosticRegistry({ limits: { maxSources: 65 } })).toThrow();
    expect(() => new DiagnosticRegistry({ limits: { maxDescriptorBytes: MAX_MESSAGE_BYTES } })).toThrow();
  });
});
