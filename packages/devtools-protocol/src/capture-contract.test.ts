import { expect, it } from 'vitest';
import { advanceCursor, cursorFromSnapshot, decodeMessage, encodeMessage, projectObservation, projectSource, refreshCursor } from './index.js';
import { batchFixture, refreshFixtures, scopedRefreshFixture, snapshotFixture, sourceEndedFixture } from './fixtures.js';

it('delivers the accounted refresh loss before the snapshot and leaves scoped replies outside the cursor', () => {
  let cursor = cursorFromSnapshot(snapshotFixture);
  for (const frame of [batchFixture, ...refreshFixtures]) {
    const result = decodeMessage(encodeMessage(frame));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('invalid fixture');
    const message = result.message;
    if (message.kind === 'batch') {
      const next = advanceCursor(cursor, message);
      expect(next.kind).toBe('accept');
      if (next.kind === 'accept') {
        expect(next.lost).toBe(message.toSeq === '9');
        cursor = next.cursor;
      }
    } else if (message.kind === 'snapshot') {
      const next = refreshCursor(cursor, message);
      expect(next.kind).toBe('accept');
      if (next.kind === 'accept') cursor = next.cursor;
    }
  }
  expect(cursor.watermark).toBe('9');
  const detail = decodeMessage(encodeMessage(scopedRefreshFixture));
  if (!detail.ok || detail.message.kind !== 'snapshot') throw new Error('invalid fixture');
  expect(refreshCursor(cursor, detail.message)).toEqual({ kind: 'ignore', reason: 'scoped-snapshot' });
  const end = decodeMessage(encodeMessage(sourceEndedFixture));
  if (!end.ok || end.message.kind !== 'batch') throw new Error('invalid fixture');
  expect(advanceCursor(cursor, end.message).kind).toBe('accept');
  expect(end.message.events[0]!.fact).toEqual({ kind: 'source_state', state: 'ended', reason: 'disposed' });
});

it('projects through the same readers without invoking unknown getters or retaining nested source input', () => {
  const source = { ...snapshotFixture.source, modules: [{ name: 'm', version: '1', buildId: null }],
    get token() { throw new Error('secret'); } };
  const copy = projectSource(source);
  source.modules[0]!.name = 'changed';
  expect(copy.modules[0]!.name).toBe('m');
  expect(copy).not.toHaveProperty('token');
  const event = { ...batchFixture.events[0], fact: { ...batchFixture.events[0].fact,
    get payload() { throw new Error('media'); } } };
  expect(projectObservation(event)).toEqual({ clockId: event.clockId, timeMs: event.timeMs, fact: batchFixture.events[0].fact });
  expect(() => projectObservation({ ...event, timeMs: Infinity })).toThrow();
});
