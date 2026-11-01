import { describe, expect, it, vi } from 'vitest';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import type { Message } from '@openmoq/devtools-protocol';
import { fixtureSource } from '@openmoq/devtools-protocol/fixtures';
import { DiagnosticCapture } from './capture.js';
import { DiagnosticRegistry } from './registry.js';

const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
function rig(text = 'trace') {
  const registry = new DiagnosticRegistry();
  const capture = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached' }, clock: { id: 'clock', now: () => 10 } });
  const recorder = { start: vi.fn(), stop: vi.fn(), dump: vi.fn(() => text), dispose: vi.fn() };
  const createRecorder = vi.fn(() => ({ ...recorder }));
  const revoke = registry.register(capture, { createRecorder });
  const owner = registry.open('owner');
  const send = (m: Message) => owner.request(encodeMessage(m)).map(decode);
  const initial = send({ ...common, kind: 'attach', requestId: 'attach', target: { ownerId: 'owner', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } })[0];
  if (initial?.kind !== 'snapshot') throw new Error('Expected attachment');
  const target = initial.target;
  const start = () => {
    const result = send({ ...common, kind: 'record.start', requestId: 'start', target })[0];
    if (result?.kind !== 'record.started') throw new Error(`Expected record.started, got ${JSON.stringify(result)}`);
    return result;
  };
  return { registry, capture, owner, recorder, createRecorder, revoke, send, target, start };
}
function decode(frame: string): Message {
  const d = decodeMessage(frame); if (!d.ok) throw new Error('Invalid frame'); return d.message;
}

describe('recording authority at the registry', () => {
  it('does not create a recorder at registration or attachment; publishes start and stop facts', () => {
    const r = rig(); expect(r.createRecorder).not.toHaveBeenCalled();
    const started = r.start(); expect(r.recorder.start).toHaveBeenCalledOnce();
    const frame = r.owner.pull(); if (!frame) throw new Error('Expected recording fact');
    expect(decode(frame)).toMatchObject({ kind: 'batch', events: [expect.objectContaining({ fact: { kind: 'recording', state: 'recording', recordingId: started.recordingId, ownerAttachmentId: r.target.attachmentId } })] });
    expect(frame).not.toContain(started.token);
    expect(r.send({ ...common, kind: 'record.stop', requestId: 'stop', target: r.target, recordingId: started.recordingId, token: started.token })).toMatchObject([{ kind: 'ack' }]);
    expect(r.recorder.stop).toHaveBeenCalledOnce();
    expect(decode(r.owner.pull()!)).toMatchObject({ kind: 'batch', events: [expect.objectContaining({ fact: expect.objectContaining({ state: 'stopped' }) })] });
  });

  it('refuses the wrong token without invoking the recorder', () => {
    const r = rig(); const started = r.start();
    expect(r.send({ ...common, kind: 'record.stop', requestId: 'wrong', target: r.target, recordingId: started.recordingId, token: 'wrong' })).toMatchObject([{ kind: 'error', code: 'not-owner' }]);
    expect(r.recorder.stop).not.toHaveBeenCalled();
  });

  it('admits one active recorder per source, then preserves stopped data for its owner', () => {
    const r = rig(); const started = r.start(); const other = r.registry.open('other');
    const attachment = decode(other.request(encodeMessage({ ...common, kind: 'attach', requestId: 'other-attach', target: { ...r.target, ownerId: 'other' } }))[0]!);
    if (attachment.kind !== 'snapshot') throw new Error('Expected other attachment');
    const otherStart = { ...common, kind: 'record.start', requestId: 'other-start', target: attachment.target } as const;
    expect(decode(other.request(encodeMessage(otherStart))[0]!)).toMatchObject({ kind: 'error', code: 'invalid-state' });
    r.send({ ...common, kind: 'record.stop', requestId: 'stop', target: r.target, recordingId: started.recordingId, token: started.token });
    expect(decode(other.request(encodeMessage(otherStart))[0]!).kind).toBe('record.started');
    expect(r.send({ ...common, kind: 'record.export', requestId: 'export', target: r.target, recordingId: started.recordingId, token: started.token })[0]).toMatchObject({ kind: 'export.chunk', data: 'trace', final: true });
  });

  it('pages an export across pulls and cancels it on detach', () => {
    const r = rig('😀'.repeat(20000)); const started = r.start();
    r.send({ ...common, kind: 'record.stop', requestId: 'stop', target: r.target, recordingId: started.recordingId, token: started.token });
    expect(r.send({ ...common, kind: 'record.export', requestId: 'export', target: r.target, recordingId: started.recordingId, token: started.token })[0]).toMatchObject({ kind: 'export.chunk', index: 0, final: false });
    expect(r.send({ ...common, kind: 'record.export', requestId: 'again', target: r.target, recordingId: started.recordingId, token: started.token })[0]).toMatchObject({ kind: 'error', code: 'invalid-state' });
    r.send({ ...common, kind: 'detach', requestId: 'detach', target: r.target });
    expect(r.owner.pull()).toBeNull(); expect(r.recorder.dispose).toHaveBeenCalledOnce();
  });

  it.each(['close', 'withdraw', 'dispose'] as const)('releases recorder authority on %s', how => {
    const r = rig(); r.start();
    if (how === 'close') r.owner.close(); else if (how === 'withdraw') r.revoke(); else r.registry.dispose();
    expect(r.recorder.stop).toHaveBeenCalledOnce(); expect(r.recorder.dispose).toHaveBeenCalledOnce();
  });

  it('does not return a token when start closes the owner reentrantly', () => {
    const r = rig(); r.recorder.start.mockImplementation(() => r.owner.close());
    expect(r.send({ ...common, kind: 'record.start', requestId: 'start', target: r.target })).toEqual([]);
    expect(r.recorder.dispose).toHaveBeenCalledOnce();
  });

  it('releases export admission immediately on the final chunk', () => {
    const r = rig(); const started = r.start();
    r.send({ ...common, kind: 'record.stop', requestId: 'stop', target: r.target, recordingId: started.recordingId, token: started.token });
    const request = { ...common, kind: 'record.export', requestId: 'export', target: r.target, recordingId: started.recordingId, token: started.token } as const;
    expect(r.send(request)[0]).toMatchObject({ kind: 'export.chunk', final: true });
    expect(r.send({ ...request, requestId: 'again' })[0]).toMatchObject({ kind: 'export.chunk', final: true });
  });

  it('keeps a stopped recording retryable when serialization fails', () => {
    const r = rig(); const started = r.start();
    r.send({ ...common, kind: 'record.stop', requestId: 'stop', target: r.target, recordingId: started.recordingId, token: started.token });
    r.recorder.dump.mockImplementationOnce(() => { throw new Error('Temporary serialization failure'); });
    const request = { ...common, kind: 'record.export', requestId: 'export', target: r.target, recordingId: started.recordingId, token: started.token } as const;
    expect(r.send(request)[0]).toMatchObject({ kind: 'error', code: 'internal' });
    expect(r.recorder.dispose).not.toHaveBeenCalled();
    expect(r.send({ ...request, requestId: 'retry' })[0]).toMatchObject({ kind: 'export.chunk', final: true });
  });

  it('disposes a recorder whose stop throws and publishes its ended ownership', () => {
    const r = rig(); const started = r.start(); r.owner.pull();
    r.recorder.stop.mockImplementation(() => { throw new Error('Partial stop'); });
    expect(r.send({ ...common, kind: 'record.stop', requestId: 'stop', target: r.target, recordingId: started.recordingId, token: started.token })[0]).toMatchObject({ kind: 'error', code: 'internal' });
    expect(r.recorder.dispose).toHaveBeenCalledOnce();
    expect(decode(r.owner.pull()!)).toMatchObject({ kind: 'batch', events: [expect.objectContaining({ fact: expect.objectContaining({ state: 'stopped' }) })] });
  });
});
