import { describe, expect, it } from 'vitest';
import { advanceCursor, cursorFromSnapshot } from './cursor.js';
import { batchFixture, gapFixture, snapshotFixture } from './fixtures.js';

describe('diagnostic stream cursor', () => {
  it('starts from a snapshot watermark and advances exactly once per batch', () => {
    const before = cursorFromSnapshot(snapshotFixture);
    const result = advanceCursor(before, batchFixture);
    expect(result).toEqual({ kind: 'accept', lost: false,
      cursor: { ...before, watermark: '6', clocks: ['mock-clock'] } });
    expect(before.watermark).toBe('5');
    if (result.kind !== 'accept') return;
    expect(advanceCursor(result.cursor, batchFixture)).toEqual({ kind: 'ignore', reason: 'already-applied' });
  });

  it.each(['ownerId', 'sourceId', 'runId', 'attachmentId'] as const)('ignores another %s', (field) => {
    const cursor = cursorFromSnapshot(snapshotFixture);
    expect(advanceCursor(cursor, { ...batchFixture, target: { ...batchFixture.target, [field]: 'other' } }))
      .toEqual({ kind: 'ignore', reason: 'different-target' });
  });

  it('advances an accounted loss but reports it separately from object gaps', () => {
    const cursor = cursorFromSnapshot({ ...snapshotFixture, watermark: '6' });
    expect(advanceCursor(cursor, gapFixture)).toEqual({ kind: 'accept', lost: true,
      cursor: { ...cursor, watermark: '9' } });
  });

  it('requests a new snapshot on a delivery hole', () => {
    expect(advanceCursor(cursorFromSnapshot(snapshotFixture), gapFixture))
      .toEqual({ kind: 'resnapshot', reason: 'sequence-gap' });
  });

  it('does not partially apply a batch overlapping the current watermark', () => {
    const cursor = cursorFromSnapshot({ ...snapshotFixture, watermark: '8' });
    expect(advanceCursor(cursor, gapFixture)).toEqual({ kind: 'resnapshot', reason: 'sequence-overlap' });
  });

  it('requires a snapshot to introduce a new clock', () => {
    const batch = { ...batchFixture, events: [{ ...batchFixture.events[0], clockId: 'new-clock' }] };
    expect(advanceCursor(cursorFromSnapshot(snapshotFixture), batch))
      .toEqual({ kind: 'resnapshot', reason: 'unknown-clock' });
    const next = cursorFromSnapshot({ ...snapshotFixture, clocks: [...snapshotFixture.clocks,
      { id: 'new-clock', kind: 'monotonic', unit: 'ms' }] });
    expect(advanceCursor(next, batch).kind).toBe('accept');
  });

  it('keeps sequence comparisons exact beyond the safe-integer boundary', () => {
    const cursor = cursorFromSnapshot({ ...snapshotFixture, watermark: '9007199254740992' });
    const batch = { ...batchFixture, fromSeq: '9007199254740993', toSeq: '9007199254740993',
      events: [{ ...batchFixture.events[0], seq: '9007199254740993' }] };
    expect(advanceCursor(cursor, batch)).toEqual({ kind: 'accept', lost: false,
      cursor: { ...cursor, watermark: '9007199254740993' } });
  });

  it('never treats a scoped inspection as a replacement for the whole source', () => {
    expect(() => cursorFromSnapshot({ ...snapshotFixture,
      scope: { kind: 'group', sessionId: 'session-1', trackAlias: '100', groupId: '0' } })).toThrow(/source snapshot/);
  });
});
