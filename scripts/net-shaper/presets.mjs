// Downlink is the bottleneck; the uplink only adds the return half of a
// 40 ms RTT so the relay's congestion controller sees a plausible path.
export const netShapePresets = {
  'cap-1m': { down: { rateBps: 1_000_000, delayMs: 20 }, up: { delayMs: 20 } },
  'step-5m-1m': { down: { rateBps: 5_000_000, delayMs: 20, schedule: [{ atMs: 20_000, rateBps: 1_000_000 }] }, up: { delayMs: 20 } },
  jitter: { down: { rateBps: 10_000_000, delayMs: 20, jitterMs: 30 }, up: { delayMs: 20 } },
  ample: { down: { rateBps: 30_000_000, delayMs: 20 }, up: { delayMs: 20 } },
};
