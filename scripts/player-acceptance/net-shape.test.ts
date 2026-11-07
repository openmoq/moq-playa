import { expect, it } from 'vitest';
import { netShapeOption, shapedUrl, summarizeAbrTrace } from './net-shape.mjs';
import type { LinkStats } from '../net-shaper/shaper.mjs';

it('stays unshaped unless a preset is named', async () => {
  expect(await netShapeOption(['--case', 'x'], {})).toBeNull();
  expect(await netShapeOption([], { PLAYER_NET_SHAPE: '' })).toBeNull();
  expect((await netShapeOption(['--net-shape', 'ample'], { PLAYER_NET_SHAPE: 'cap-1m' }))?.preset).toBe('ample');
  expect((await netShapeOption([], { PLAYER_NET_SHAPE: 'cap-1m', PLAYER_NET_SHAPE_SECONDS: '30' }))?.durationMs).toBe(30000);
  await expect(netShapeOption([], { PLAYER_NET_SHAPE: 'dialup' })).rejects.toThrow(/Unknown net shape/);
});

it('changes only the port of the relay URL', () => {
  expect(shapedUrl('https://127.0.0.1:4433/moq', 50123)).toBe('https://127.0.0.1:50123/moq');
});

it('puts browser events on the shaper downlink time base', () => {
  const down = { firstPacketMs: 500, deliveredBps: 990000, deliveredPackets: 10, lossPackets: 0, tailPackets: 3,
    queue: { maxBytes: 12000 }, lateness: { p99Ms: 0.5, maxMs: 1 },
    timeline: [400, 600, 1400, 1600].map((tMs, i) => ({ tMs, deliveredBps: [9e6, 1e6, 2e6, 0][i], queueBytes: i * 100 })) } as unknown as LinkStats;
  const summary = summarizeAbrTrace({ timeOrigin: 1_000_000, events: [
    { timeMs: 2500, type: 'quality_switched', data: { fromTrackName: 'video-1080', toTrackName: 'video-360', reason: 'abr-down' } },
    { timeMs: 3000, type: 'stall', data: { durationMs: 250 } },
    ...[3100, 3200].map(timeMs => ({ timeMs, type: 'quality_switch_failed',
      data: { fromTrackName: 'video-360', toTrackName: 'video-720', reason: 'abr-up', error: 'Error: closed' } })),
    { timeMs: 3700, type: 'stall_recovered', data: { durationMs: 950 } },
    { timeMs: 4000, type: 'stats', data: { captureTimestampAgeMs: 1200 } },
  ] }, { startedAtEpochMs: 1_001_000, down });
  expect(summary.switches).toEqual([{ atS: 1, from: 'video-1080', to: 'video-360', reason: 'abr-down' }]);
  expect(summary.stalls).toEqual([{ atS: 1.5, detectedAfterMs: 250 }]);
  expect(summary.failedSwitches).toEqual([{ atS: 1.6, lastAtS: 1.7, repeats: 2, from: 'video-360', to: 'video-720',
    reason: 'abr-up', error: 'Error: closed' }]);
  expect(summary.stalledMs).toBe(950);
  expect(summary.captureAge).toEqual({ samples: 1, maxMs: 1200, last: { atS: 2.5, ageMs: 1200 } });
  expect(summary.shaper?.tailPackets).toBe(3);
  expect(summary.shaper?.downlinkMbps).toEqual([1.5, 0]);
  expect(summary.shaper?.queueMaxBytes).toEqual([200, 300]);
});
