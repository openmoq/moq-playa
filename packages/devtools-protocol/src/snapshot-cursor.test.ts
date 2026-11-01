import { describe, expect, it } from 'vitest';
import { cursorFromSnapshot, advanceCursor, refreshCursor } from './cursor.js';
import { batchFixture, gapFixture, snapshotFixture } from './fixtures.js';

describe('snapshot refresh ownership', () => {
  it('does not rewind after later batches have already arrived', () => {
    const first = advanceCursor(cursorFromSnapshot(snapshotFixture), batchFixture);
    expect(first.kind).toBe('accept');
    if (first.kind !== 'accept') return;
    const second = advanceCursor(first.cursor, gapFixture);
    expect(second.kind).toBe('accept');
    if (second.kind !== 'accept') return;
    expect(refreshCursor(second.cursor, snapshotFixture)).toEqual({ kind: 'ignore', reason: 'stale-snapshot' });
    expect(second.cursor.watermark).toBe('9');
  });

  it.each(['ownerId', 'sourceId', 'runId', 'attachmentId'] as const)('does not replace a different %s', field => {
    const current = cursorFromSnapshot(snapshotFixture);
    const target = { ...snapshotFixture.target, [field]: 'other' };
    const response = { ...snapshotFixture, target,
      source: { ...snapshotFixture.source, sourceId: target.sourceId, runId: target.runId } };
    expect(refreshCursor(current, response)).toEqual({ kind: 'ignore', reason: 'different-target' });
  });

  it('does not reset the source cursor with a newer scoped response', () => {
    const current = cursorFromSnapshot(snapshotFixture);
    expect(refreshCursor(current, { ...snapshotFixture, watermark: '7',
      scope: { kind: 'group', sessionId: 'session-1', trackAlias: '100', groupId: '0' } }))
      .toEqual({ kind: 'ignore', reason: 'scoped-snapshot' });
  });

  it('accepts an equally current snapshot with no duplicate event application', () => {
    const current = cursorFromSnapshot(snapshotFixture);
    expect(refreshCursor(current, snapshotFixture)).toEqual({ kind: 'accept', cursor: current });
  });

  it('accepts a newer source snapshot and its clock declarations', () => {
    const current = cursorFromSnapshot(snapshotFixture);
    const clocks = [...snapshotFixture.clocks, { id: 'next-clock', kind: 'monotonic', unit: 'ms' }] as const;
    const next = { ...snapshotFixture, watermark: '8', clocks };
    expect(refreshCursor(current, next)).toEqual({ kind: 'accept', cursor: cursorFromSnapshot(next) });
    expect(current.watermark).toBe('5');
    expect(current.clocks).toEqual(['mock-clock']);
  });

  it('compares refresh watermarks without losing uint64 precision', () => {
    const current = cursorFromSnapshot({ ...snapshotFixture, watermark: '9007199254740993' });
    expect(refreshCursor(current, { ...snapshotFixture, watermark: '9007199254740992' }))
      .toEqual({ kind: 'ignore', reason: 'stale-snapshot' });
    expect(refreshCursor(current, { ...snapshotFixture, watermark: '9007199254740994' }))
      .toMatchObject({ kind: 'accept', cursor: { watermark: '9007199254740994' } });
  });
});
