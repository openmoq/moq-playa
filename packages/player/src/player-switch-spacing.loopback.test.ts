/** Real SDK quality-request admission and LOC decoding; no native rendering claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { audioPeer } from '../test-support/audio-selection.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import type { QualitySwitchFailedEvent } from './events.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());

async function fixture(version: string | number, spacing: readonly (number | undefined)[]) {
  const wire = audioPeer(23), namespace = ['live', 'spacing'];
  const ref = (name: string) => ({ name, namespace });
  const warnings: string[] = [], failures: QualitySwitchFailedEvent[] = [], decoded: number[] = [];
  let now = 1_000_000;
  const player = new MoqtPlayer({ url: 'https://spacing.invalid/moq', namespace, draftVersion: 23,
    catalogBootstrap: 'subscribe', disableAudio: true, startLevel: 0, autoQuality: true,
    livenessTimeoutMs: 0, clock: { now: () => now },
    logger: { debug() {}, info() {}, error() {}, warn(message, ...args) { warnings.push([message, ...args].join(" ")); } },
    createConnection: () => wire.client, createTransport: async () => wire.start(),
    createVideoDecoder: () => ({ configure() {}, decode(chunk) { decoded.push(chunk.data[5]!); },
      flush: async () => {}, reset() {}, destroy() {}, onFrame: null, onError: null }),
    createRenderer: () => ({ enqueue() {}, flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null }),
  });
  player.on('quality_switch_failed', event => { failures.push(event); });
  const catalog = new TextEncoder().encode(JSON.stringify({ version, tracks: (spacing.length === 3 ? ['high', 'mid', 'low'] : ['high', 'low']).map((name, i) => ({
    name, role: 'video', packaging: 'loc', codec: 'avc1.640028', renderGroup: 1, altGroup: 7,
    bitrate: i === 0 ? 600000 : spacing.length === 3 && i === 1 ? 300000 : 150000, framerate: 25, isLive: false, keyframeSpacing: spacing[i],
  })) }));
  async function send(name: string, group: bigint, marker: number, object = 0n) {
    now += 40_000;
    await wire.send(ref(name), Uint8Array.of(0, 0, 0, 2, 0x65, marker), group, object,
      encodeLocHeaders({ captureTimestamp: BigInt(now), videoFrameMarking: {
        startOfFrame: true, endOfFrame: true, independent: true, discardable: false, baseLayerSync: false, temporalId: 0,
      } }, { wireProfile: locWireProfileForDraft(23) }));
    player.tick(); await flush(256);
  }
  await player.load(); await wire.accept(ref('catalog'), 100n); await wire.send(ref('catalog'), catalog, 1n);
  await wire.accept(ref('high'), 200n); player.play(); await send('high', 9n, 11);
  expect(player.selection.video?.name).toBe('high'); expect(decoded).toContain(11);
  return { player, wire, ref, send, warnings, failures, decoded,
    async destroy() { await player.destroy(); await wire.close(); } };
}

it.each(['automatic', 'manual'] as const)('refuses a draft-02 %s quality request across dissimilar spacing', async mode => {
  for (const spacing of [[15, 60], [15, undefined], [undefined, 60]]) {
    const f = await fixture('draft-02', spacing);
    try {
      // Exercise the same automatic request entry used by the bandwidth controller.
      const selecting = mode === 'automatic' ? f.player.selectVideoTrack('low', 'bandwidth', 'downshift') : f.player.selectVideoTrack('low');
      await expect(selecting).rejects.toThrow(/keyframeSpacing/);
      await flush(256);
      expect(f.wire.requests.map(r => r.name)).toEqual(['catalog', 'high']);
      expect(f.wire.stopped).not.toContain(f.wire.request(f.ref('high')).id);
      expect(f.player.selection.video?.name).toBe('high');
      expect(f.player.selection.autoQuality).toBe(true);
      expect(f.failures).toEqual([expect.objectContaining({ fromTrackName: 'high', toTrackName: 'low',
        reason: mode === 'automatic' ? 'bandwidth' : 'manual', error: expect.objectContaining({ message: expect.stringContaining('keyframeSpacing') }) })]);
      expect(f.warnings.some(message => message.includes('keyframeSpacing'))).toBe(true);
      await f.send('high', 9n, 12, 1n); expect(f.decoded).toContain(12);
    } finally { await f.destroy(); }
  }
});

// Existing behavior: these controls must also pass before the restriction exists.
it.each([
  { version: 'draft-02', spacing: [15, 15] }, { version: 'draft-02', spacing: [undefined, undefined] },
  { version: 'draft-01', spacing: [15, 60] }, { version: 1, spacing: [15, 60] },
])('preserves the group-aligned switch for $version with $spacing', async ({ version, spacing }) => {
  const f = await fixture(version, spacing);
  try {
    await f.player.selectVideoTrack('low'); await flush(256);
    await f.wire.accept(f.ref('low'), 201n); await f.send('low', 10n, 22);
    expect(f.player.selection.video?.name).toBe('low'); expect(f.decoded).toContain(22);
    expect(f.wire.stopped).toContain(f.wire.request(f.ref('high')).id);
    expect(f.failures).toEqual([]); expect(f.wire.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it('downshifts past an incompatible middle rung without repeated switch failures', async () => {
  const f = await fixture('draft-02', [60, 30, 60]);
  // Model sustained bandwidth pressure while retaining the real player switch and transport.
  const policy = f.player as unknown as { bufferAbrController: { evaluate(): { action: string } }; evaluateBandwidthAdaptation(): void };
  vi.spyOn(policy.bufferAbrController, 'evaluate').mockReturnValue({ action: 'downshift' });
  try {
    for (let i = 0; i < 10; i++) { policy.evaluateBandwidthAdaptation(); await flush(64); }
    expect(f.wire.requests.map(r => r.name)).toEqual(['catalog', 'high', 'low']);
    await f.wire.accept(f.ref('low'), 201n); await f.send('low', 10n, 22);
    expect(f.player.selection.video?.name).toBe('low');
    expect(f.decoded).toContain(22);
    expect(f.failures).toEqual([]);
  } finally { await f.destroy(); }
});
