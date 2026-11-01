import { describe, expect, it, vi } from 'vitest';
import { decodeCarrierReply, decodeMessage, encodeCarrierRequest, encodeMessage, MAX_CARRIER_BYTES, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import type { CarrierReply, CarrierRequest, Message, Snapshot } from '@openmoq/devtools-protocol';
import { fixtureSource, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { DiagnosticCapture } from './capture.js';
import type { CaptureOptions } from './types.js';
import { DiagnosticRegistry } from './registry.js';
import { DiagnosticCarrier } from './carrier.js';

const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
const discovery = encodeMessage({ ...common, kind: 'discover', ownerId: 'reader', requestId: 'discovery' });
function unwrap(input: string | null): CarrierReply {
  expect(input).not.toBeNull();
  expect(new TextEncoder().encode(input!).byteLength).toBeLessThanOrEqual(MAX_CARRIER_BYTES);
  const result = decodeCarrierReply(input);
  if (!result.ok) throw new Error('Invalid carrier reply');
  return result.packet;
}
function data(input: string | null): Extract<CarrierReply, { kind: 'reply' }> {
  const reply = unwrap(input);
  if (reply.kind !== 'reply') throw new Error(`Expected data reply, got ${reply.reason}`);
  return reply;
}
function decode(frames: readonly string[]): Message[] {
  return frames.map(frame => {
    const result = decodeMessage(frame);
    if (!result.ok) throw new Error('Invalid protocol frame');
    return result.message;
  });
}
function setup(overrides: Partial<CaptureOptions> = {}) {
  const clock = { time: 10 };
  const activity = vi.fn();
  const source = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached' },
    clock: { id: 'capture', now: () => clock.time }, onActiveChange: activity, ...overrides });
  const registry = new DiagnosticRegistry(); const revoke = registry.register(source);
  const connection = registry.open('reader');
  const carrier = new DiagnosticCarrier(connection, { now: () => clock.time, idleTimeoutMs: 1000 });
  const exchange = (packet: CarrierRequest) => carrier.receive(encodeCarrierRequest(packet));
  const initial = () => data(carrier.start(discovery));
  const bind = () => {
    const reply = data(exchange({ kind: 'request', receipt: initial().receipt, message: encodeMessage({ ...common, kind: 'attach',
      requestId: 'attach', target: { ownerId: 'reader', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } }) }));
    const snapshot = decode(reply.frames)[0];
    if (snapshot?.kind !== 'snapshot') throw new Error('Expected attached snapshot');
    return { reply, snapshot };
  };
  return { clock, activity, source, registry, revoke, connection, carrier, exchange, initial, bind };
}
function refresh(snapshot: Snapshot): string {
  return encodeMessage({ ...common, kind: 'snapshot.request', requestId: 'refresh', target: snapshot.target, scope: { kind: 'source' } });
}

describe('reader-credit diagnostic carrier', () => {
  it('discovers without activating and issues a fresh receipt even for an empty poll', () => {
    const c = setup(); const first = c.initial();
    expect(decode(first.frames)).toMatchObject([{ kind: 'hello', requestId: 'discovery' }]);
    expect(c.activity).not.toHaveBeenCalled();
    expect(c.carrier.deadlineMs).toBe(1010);
    const poll = data(c.exchange({ kind: 'poll', receipt: first.receipt }));
    expect(poll.frames).toEqual([]); expect(poll.receipt).not.toBe(first.receipt);
  });

  it('does not push from observers, and drains then refreshes under one receipt', () => {
    const c = setup(); const { reply, snapshot } = c.bind();
    c.source.emit(snapshotFixture.facts[3].fact, 'dense');
    expect(c.carrier.expire()).toBeNull();
    const renewed = data(c.exchange({ kind: 'request', receipt: reply.receipt, message: refresh(snapshot) }));
    expect(decode(renewed.frames).map(f => f.kind)).toEqual(['batch', 'snapshot']);
    expect(data(c.exchange({ kind: 'poll', receipt: renewed.receipt })).frames).toEqual([]);
  });

  it('makes replayed credit terminal before another registry operation', () => {
    const c = setup(); const first = c.initial();
    const pull = vi.spyOn(c.connection, 'pull');
    data(c.exchange({ kind: 'poll', receipt: first.receipt }));
    expect(unwrap(c.exchange({ kind: 'poll', receipt: first.receipt }))).toMatchObject({ kind: 'closed', reason: 'invalid-receipt' });
    expect(pull).toHaveBeenCalledTimes(1); expect(c.connection.closed).toBe(true);
    expect(c.carrier.receive('anything')).toBeNull(); expect(c.carrier.close()).toBeNull();
  });

  it('rejects a guessed future receipt and releases the current capture lease', () => {
    const c = setup(); c.bind();
    expect(unwrap(c.exchange({ kind: 'poll', receipt: '999.' + 'a'.repeat(32) }))).toMatchObject({ reason: 'invalid-receipt' });
    expect(c.source.active).toBe(false); expect(c.activity.mock.calls).toEqual([[true], [false]]);
  });

  it('isolates receipts to the actual carrier, even for identical owner/source names', () => {
    const a = setup(); const b = setup(); const aa = a.bind(); const bb = b.bind();
    expect(aa.reply.receipt).not.toBe(bb.reply.receipt);
    expect(unwrap(a.exchange({ kind: 'poll', receipt: bb.reply.receipt }))).toMatchObject({ reason: 'invalid-receipt' });
    expect(a.source.active).toBe(false); expect(b.source.active).toBe(true);
    expect(data(b.exchange({ kind: 'poll', receipt: bb.reply.receipt })).frames).toEqual([]);
    b.carrier.close();
  });

  it('checks the deadline before late credit can renew a lease', () => {
    const c = setup(); const { reply } = c.bind(); c.clock.time = 1010;
    expect(unwrap(c.exchange({ kind: 'poll', receipt: reply.receipt }))).toMatchObject({ reason: 'idle-timeout' });
    expect(c.source.active).toBe(false); expect(c.carrier.deadlineMs).toBeNull();
  });

  it('expires idle readers without receiving another packet, once only', () => {
    const c = setup(); const { reply } = c.bind(); c.clock.time = 1009;
    expect(c.carrier.expire()).toBeNull();
    data(c.exchange({ kind: 'poll', receipt: reply.receipt }));
    expect(c.carrier.deadlineMs).toBe(2009); c.clock.time = 2009;
    expect(unwrap(c.carrier.expire())).toMatchObject({ reason: 'idle-timeout' });
    expect(c.carrier.expire()).toBeNull(); expect(c.source.active).toBe(false);
  });

  it.each(['page-hidden', 'bridge-disposed', 'owner-closed'] as const)('sends one terminal packet on %s even with data credit outstanding', reason => {
    const c = setup(); c.bind();
    expect(unwrap(c.carrier.close(reason))).toEqual({ kind: 'closed', reason, connectionReason: null });
    expect(c.carrier.close(reason)).toBeNull(); expect(c.connection.closed).toBe(true);
    expect(c.source.active).toBe(false); expect(c.carrier.deadlineMs).toBeNull();
  });

  it('allows port-bound explicit close without needing an unread receipt', () => {
    const c = setup(); c.bind();
    expect(unwrap(c.exchange({ kind: 'close' }))).toMatchObject({ reason: 'owner-closed' });
    expect(c.source.active).toBe(false);
  });

  it('keeps source end and withdrawal observable without closing the carrier', () => {
    const c = setup(); const { reply, snapshot } = c.bind(); c.source.dispose();
    const ended = data(c.exchange({ kind: 'poll', receipt: reply.receipt }));
    expect(decode(ended.frames)).toMatchObject([{ kind: 'batch', events: [{ fact: { kind: 'source_state', state: 'ended' } }] }]);
    c.revoke();
    const withdrawn = data(c.exchange({ kind: 'poll', receipt: ended.receipt }));
    expect(decode(withdrawn.frames)).toMatchObject([{ kind: 'error', requestId: 'attach', target: snapshot.target, code: 'not-found' }]);
    expect(c.carrier.closed).toBe(false);
  });

  it('reports registry closure independently of capture or carrier loss', () => {
    const c = setup(); c.bind(); c.registry.dispose();
    expect(unwrap(c.carrier.expire())).toEqual({ kind: 'closed', reason: 'registry-closed', connectionReason: 'registry-disposed' });
    expect(c.source.active).toBe(false);
  });

  it('reports malformed inner commands through the registry close reason', () => {
    const c = setup(); const first = c.initial();
    expect(unwrap(c.exchange({ kind: 'request', receipt: first.receipt, message: 'secret, not JSON' })))
      .toEqual({ kind: 'closed', reason: 'registry-closed', connectionReason: 'invalid-message' });
  });

  it('refuses outer corruption, wrong direction, repeated bootstrap and pre-bootstrap commands', () => {
    const a = setup(); a.bind();
    expect(unwrap(a.carrier.receive('secret, not JSON'))).toMatchObject({ reason: 'invalid-packet' });
    expect(a.source.active).toBe(false);
    const b = setup(); const reply = b.carrier.start(discovery);
    expect(unwrap(b.carrier.receive(reply))).toMatchObject({ reason: 'invalid-packet' });
    const c = setup(); c.initial();
    expect(unwrap(c.carrier.start(discovery))).toMatchObject({ reason: 'invalid-packet' });
    const d = setup();
    expect(unwrap(d.exchange({ kind: 'poll', receipt: '0.' + 'a'.repeat(32) }))).toMatchObject({ reason: 'invalid-packet' });
  });

  it('requires discovery for bootstrap instead of silently permitting an attach', () => {
    const c = setup();
    expect(unwrap(c.carrier.start(encodeMessage({ ...common, kind: 'attach', requestId: 'attach', target: {
      ownerId: 'reader', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } })))).toMatchObject({ reason: 'invalid-packet' });
    expect(c.activity).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1, 9])('closes on invalid or regressing clock %s', now => {
    const c = setup(); c.bind(); c.clock.time = now;
    expect(unwrap(c.carrier.expire())).toMatchObject({ reason: 'clock-error' });
    expect(c.source.active).toBe(false);
  });

  it('contains clock exceptions and never includes the exception text', () => {
    const c = setup();
    const carrier = new DiagnosticCarrier(c.connection, { now: () => { throw new Error('secret'); } });
    const closed = carrier.start(discovery);
    expect(unwrap(closed)).toMatchObject({ reason: 'clock-error' });
    expect(closed).not.toContain('secret'); expect(c.connection.closed).toBe(true);
  });

  it('closes on reentrant expiry and returns the terminal notice to the outer exchange only', () => {
    let carrier!: DiagnosticCarrier; let nested: string | null = 'not called';
    const c = setup({ onActiveChange: active => { if (active) nested = carrier.expire(); } }); carrier = c.carrier;
    const first = c.initial();
    const result = c.exchange({ kind: 'request', receipt: first.receipt, message: encodeMessage({ ...common, kind: 'attach',
      requestId: 'attach', target: { ownerId: 'reader', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } }) });
    expect(nested).toBeNull(); expect(unwrap(result)).toMatchObject({ reason: 'reentrant-exchange' });
    expect(c.source.active).toBe(false); expect(c.carrier.expire()).toBeNull();
  });

  it('does not send a late snapshot after close during activation', () => {
    let carrier!: DiagnosticCarrier;
    const c = setup({ onActiveChange: active => { if (active) expect(carrier.close('page-hidden')).toBeNull(); } }); carrier = c.carrier;
    const first = c.initial();
    const result = c.exchange({ kind: 'request', receipt: first.receipt, message: encodeMessage({ ...common, kind: 'attach',
      requestId: 'attach', target: { ownerId: 'reader', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } }) });
    expect(unwrap(result)).toMatchObject({ kind: 'closed', reason: 'page-hidden' });
    expect(c.source.active).toBe(false);
  });

  it('does not let a last-lease callback consume the outer close notification', () => {
    let carrier!: DiagnosticCarrier; let nested: string | null = 'not called';
    const c = setup({ onActiveChange: active => { if (!active) nested = carrier.expire(); } });
    carrier = c.carrier; c.bind();
    expect(unwrap(carrier.close('page-hidden'))).toMatchObject({ reason: 'page-hidden' });
    expect(nested).toBeNull(); expect(carrier.expire()).toBeNull();
  });

  it('contains output-bound and registry exceptions without leaking raw messages', () => {
    const a = setup(); vi.spyOn(a.connection, 'request').mockReturnValue(['a', 'b', 'c']);
    expect(unwrap(a.carrier.start(discovery))).toMatchObject({ reason: 'internal-error' });
    expect(a.connection.closed).toBe(true);
    const b = setup(); vi.spyOn(b.connection, 'request').mockImplementation(() => { throw new Error('secret'); });
    const result = b.carrier.start(discovery);
    expect(unwrap(result)).toMatchObject({ reason: 'internal-error' }); expect(result).not.toContain('secret');
  });

  it.each([0, -1, NaN, Infinity, 1.5, 600001])('refuses invalid timeout %s before acquiring the connection', idleTimeoutMs => {
    const c = setup();
    expect(() => new DiagnosticCarrier(c.connection, { now: () => 1, idleTimeoutMs })).toThrow();
    expect(c.connection.closed).toBe(false);
  });
});
