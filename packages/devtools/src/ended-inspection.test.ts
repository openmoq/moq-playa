import { describe, expect, it, vi } from 'vitest';
import { DiagnosticCapture } from './capture.js';
import { decodeMessage } from '@openmoq/devtools-protocol';
import { fixtureSource } from '@openmoq/devtools-protocol/fixtures';

describe('explicit read-only ended capture inspection', () => {
  it('keeps the default refusal for ended sources', () => {
    const c = new DiagnosticCapture({ source: fixtureSource, clock: { id: 'clock', now: () => 1 } });
    const keeper = c.attach('keeper', 'keep'); c.dispose();
    expect(() => c.attach('late', 'late')).toThrow(/ended/); keeper.lease.close();
  });

  it('allows retained inspection without clock access, activity or sequence resurrection', () => {
    const now = vi.fn(() => 1), activity = vi.fn();
    const c = new DiagnosticCapture({ source: fixtureSource, clock: { id: 'clock', now },
      allowEndedAttachments: true, onActiveChange: activity });
    const keeper = c.attach('keeper', 'keep'); c.dispose();
    const calls = now.mock.calls.length; activity.mockClear();
    now.mockImplementation(() => { throw new Error('Clock is gone'); });
    const late = c.attach('late', 'late');
    expect(c.active).toBe(false); expect(now).toHaveBeenCalledTimes(calls); expect(activity).not.toHaveBeenCalled();
    expect(decodeMessage(late.snapshot)).toMatchObject({ ok: true, message: {
      facts: [expect.objectContaining({ fact: { kind: 'source_state', state: 'ended', reason: 'disposed' } })],
    } });
    expect(c.emit({ kind: 'control', sessionId: 's', streamId: null, requestId: null, messageType: 'GOAWAY', direction: 'received' }, 'sparse')).toBe(false);
    expect(late.lease.pull()).toBeNull(); late.lease.close(); keeper.lease.close();
    expect(() => c.attach('another', 'gone')).toThrow(/ended/);
  });
});
