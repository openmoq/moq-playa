/** Real SDK quality-request admission and LOC decoding; no native rendering claim. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { MsfPayloadSource } from './msf-payload.js';
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
  const catalog = new TextEncoder().encode(JSON.stringify({ version, tracks: ['high', 'low'].map((name, i) => ({
    name, role: 'video', packaging: 'loc', codec: 'avc1.640028', renderGroup: 1, altGroup: 7,
    bitrate: i ? 150000 : 600000, framerate: 25, isLive: false, keyframeSpacing: spacing[i],
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

it('does not decode media after an encryption update',async()=>{
 const f=await fixture('draft-02',[undefined,undefined]);try{
 await f.wire.send(f.ref('catalog'),new TextEncoder().encode(JSON.stringify({generatedAt:2,deltaUpdate:[{op:'update',tracks:[{parentName:'high',encryptionScheme:'com.example.cipher'}]}]})),1n,1n);
 await flush(256); await f.send('high',9n,12,1n).catch(error => { expect(String(error)).toContain('Unknown outgoing stream'); });
 expect(f.wire.stopped).toContain(f.wire.request(f.ref('high')).id);
 expect(f.warnings.join(' ')).toContain('encrypted');
 expect(f.decoded).not.toContain(12);
 }finally{await f.destroy();}
});

it('skips MSF property bookkeeping for accepted media datagrams', async () => {
  const f = await fixture('draft-02', [60, 60]);
  const observe = vi.spyOn(MsfPayloadSource.prototype, 'observe');
  const receive = vi.fn(f.wire.client.onDatagram); f.wire.client.onDatagram = receive;
  try {
    await f.wire.server.sendDatagram(200n, 10n, 0n, Uint8Array.of(0, 0, 0, 2, 0x65, 19),
      encodeLocHeaders({ captureTimestamp: 1080000n, videoFrameMarking: {
        startOfFrame: true, endOfFrame: true, independent: true, discardable: false, baseLayerSync: false, temporalId: 0,
      } }, { wireProfile: locWireProfileForDraft(23) }));
    await flush(256); await f.send('high', 11n, 20);
    expect(observe).not.toHaveBeenCalled();
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ trackAlias: 200n }));
  } finally { observe.mockRestore(); await f.destroy(); }
});
