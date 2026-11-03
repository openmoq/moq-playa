import { expect, it } from 'vitest';
import { assessWarmStart } from './warm-start.mjs';
function fixture() {
  return {
    peer: { errors: [], events: [
      { type: 'accepted', name: 'video-360', request: '4', alias: '100', group: '7', object: '2' },
      { type: 'fetch', request: '8', joining: '4' },
      { type: 'prefix-released', request: '8', receiverAcknowledged: 1 },
    ] },
    observed: {
      received: [
        { seq: 1, source: 'live' as const, alias: '100', request: null, group: '7', object: '3' },
        { seq: 2, source: 'prefix' as const, alias: '0', request: '8', group: '7', object: '0' },
      ],
      processed: ['0', '1', '2', '3'].map((object, index) => ({ seq: 3 + index, alias: '100', group: '7', object })),
    },
  };
}
it('separates overtaking receipts from contiguous processing', () => {
  const h = fixture(); expect(assessWarmStart(h.observed, h.peer, true).failures).toEqual([]);
});
it.each(['tail first', 'missing head', 'duplicate', 'unrelated fetch', 'no overtaking'] as const)('refuses %s evidence', change => {
  const h = fixture();
  if (change === 'tail first') h.observed.processed = [h.observed.processed[3]!, ...h.observed.processed.slice(0, 3)];
  if (change === 'missing head') h.observed.processed.shift();
  if (change === 'duplicate') h.observed.processed.push(h.observed.processed[0]!);
  if (change === 'unrelated fetch') h.peer.events[1]!.joining = '6';
  if (change === 'no overtaking') h.observed.received[0]!.seq = 10;
  expect(assessWarmStart(h.observed, h.peer, true).passed).toBe(false);
});
it('checks the default-off path without expecting a prefix', () => {
  const h = fixture(); h.peer.events.splice(1); h.observed.received.pop();
  expect(assessWarmStart(h.observed, h.peer, false).failures).toEqual([]);
});

it('accepts a real one-object prefix without requiring an arbitrary join position', () => {
  const h = fixture(); h.peer.events[0]!.object = '0';
  h.observed.received[0]!.object = '1';
  h.observed.processed = [h.observed.processed[0]!, { seq: 4, alias: '100', group: '7', object: '1' }];
  expect(assessWarmStart(h.observed, h.peer, true).failures).toEqual([]);
});

it('refuses a prefix release without a receiver acknowledgement', () => {
  const h = fixture(); h.peer.events[2]!.receiverAcknowledged = 0;
  expect(assessWarmStart(h.observed, h.peer, true).failures).toContain('prefix-not-released-by-receiver');
});
