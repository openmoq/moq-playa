import { expect, it } from 'vitest';
import fc from 'fast-check';
import { advanceCursor, cursorFromSnapshot, decodeMessage, MAX_MESSAGE_BYTES, refreshCursor } from '@openmoq/devtools-protocol';
import type { StreamCursor } from '@openmoq/devtools-protocol';
import { fixtureSource, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { DiagnosticCapture } from './capture.js';

it('keeps independently drained leases contiguous across arbitrary overflow, refresh and reattachment', () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 150 }), actions => {
    let time = 0;
    const source = new DiagnosticCapture({ source: fixtureSource, clock: { id: 'clock', now: () => time++ },
      limits: { pendingMaxEvents: 2, pendingMaxBytes: 512, stateMaxEvents: 2, historyMaxEvents: 3, historyMaxAgeMs: 5 } });
    const open = (owner: string) => {
      const { lease, snapshot } = source.attach(owner, 'attach');
      const initial = decodeMessage(snapshot);
      if (!initial.ok || initial.message.kind !== 'snapshot') throw new Error('Invalid initial snapshot');
      return { lease, cursor: cursorFromSnapshot(initial.message) };
    };
    const owners = [open('a'), open('b')];
    const consume = (owner: { cursor: StreamCursor }, frame: string | null) => {
      if (frame === null) return;
      expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      const result = decodeMessage(frame);
      if (!result.ok) throw new Error('Invalid frame');
      if (result.message.kind === 'batch') {
        const next = advanceCursor(owner.cursor, result.message);
        expect(next.kind).toBe('accept');
        if (next.kind === 'accept') owner.cursor = next.cursor;
      } else if (result.message.kind === 'snapshot') {
        const next = refreshCursor(owner.cursor, result.message);
        if (result.message.scope.kind === 'source') {
          expect(next.kind).toBe('accept');
          if (next.kind === 'accept') owner.cursor = next.cursor;
        } else expect(next).toEqual({ kind: 'ignore', reason: 'scoped-snapshot' });
      } else throw new Error('Unexpected frame');
    };
    for (const action of actions) {
      const owner = owners[action % 2]!;
      if (action < 3) source.emit(snapshotFixture.facts[action === 0 ? 1 : 3].fact, action === 1 ? 'sparse' : 'dense');
      else if (action < 5) consume(owner, owner.lease.pull());
      else if (action === 5) for (const frame of owner.lease.refresh('refresh')) consume(owner, frame);
      else if (action === 6) for (const frame of owner.lease.refresh('detail', { kind: 'track', trackId: 'video-1' })) consume(owner, frame);
      else if (action === 7) {
        owner.lease.close(); owners[action % 2] = open('b');
      } else time += 6;
    }
    source.dispose();
    for (const owner of owners) {
      for (const frame of owner.lease.refresh('final')) consume(owner, frame);
      expect(owner.lease.pull()).toBeNull();
      owner.lease.close();
    }
  }), { numRuns: 100 });
});

it('keeps a reserved terminal event decodable with maximal identities and an overflowing snapshot', () => {
  const source = new DiagnosticCapture({
    source: { ...fixtureSource, sourceId: 's'.repeat(128), runId: 'r'.repeat(128), label: '🟡'.repeat(1024) },
    clock: { id: 'c'.repeat(128), now: () => Number.MAX_VALUE },
    limits: { pendingMaxBytes: MAX_MESSAGE_BYTES - 2048, stateMaxEvents: 100, stateMaxBytes: 1000000 },
  });
  const { lease } = source.attach('o'.repeat(128), 'q'.repeat(128));
  for (let i = 0; i < 100; i++) source.emit({ ...snapshotFixture.facts[1].fact, trackId: `t${i}`,
    identity: { namespace: ['ab'.repeat(3000)], name: 'cd' } }, 'sparse');
  source.dispose();
  const frames = lease.refresh('q'.repeat(128));
  expect(frames).toHaveLength(2);
  for (const frame of frames) {
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const result = decodeMessage(frame);
    if (!result.ok) throw new Error('Invalid frame');
    if (result.message.kind === 'batch') expect(result.message.events.at(-1)!.fact).toMatchObject({ kind: 'source_state' });
    else if (result.message.kind === 'snapshot') {
      expect(result.message.omittedFacts).toBeGreaterThan(0);
      expect(result.message.facts.at(-1)!.fact).toMatchObject({ kind: 'source_state' });
    } else throw new Error('Unexpected frame');
  }
});
