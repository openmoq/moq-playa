import { expect, it } from 'vitest';
import { parseShaperArgs } from './cli.mjs';
import { netShapePresets } from './presets.mjs';
import { createLink } from './shaper.mjs';

it('parses per-direction flags over a preset', () => {
  expect(parseShaperArgs(['--upstream', '127.0.0.1:4443', '--preset', 'cap-1m', '--down-jitter', '5',
    '--up-rate', '200000', '--down-schedule', '1000:500000,2000:800000', '--seed', '9'])).toEqual({
    listen: 0, listenHost: '127.0.0.1', upstream: '127.0.0.1:4443', seed: 9, recordPackets: false,
    down: { rateBps: 1_000_000, delayMs: 20, jitterMs: 5, schedule: [{ atMs: 1000, rateBps: 500000 }, { atMs: 2000, rateBps: 800000 }] },
    up: { delayMs: 20, rateBps: 200000 },
  });
});

it.each([
  [[], /--upstream/],
  [['--upstream', 'h:1', '--preset', 'nope'], /Unknown preset/],
  [['--upstream', 'h:1', '--down-rate', 'fast'], /needs a number/],
  [['--upstream', 'h:1', '--bogus'], /Unknown option/],
])('refuses %j', (argv, message) => {
  expect(() => parseShaperArgs(argv)).toThrow(message);
});

it('keeps every preset a valid link', () => {
  for (const preset of Object.values(netShapePresets)) {
    for (const options of [preset.down, preset.up]) createLink(options).close();
  }
});
