/** Catalog-name normalization through public configuration and real 18/22 requests. */
import { describe, expect, it } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { audioPeer, identity, type AudioDraft, type AudioRef } from '../test-support/audio-selection.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import type { AudioDecoderLike, AudioOutputLike } from './interfaces.js';
import type { ConnectionConfig, MoqtPlayerConfig } from './config.js';
import { MoqtPlayer } from './player.js';

const namespace = ['catalog', 'normalization'];
const media = { namespace, name: 'audio' };
const catalog = new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
  { name: media.name, namespace: namespace.join('/'), packaging: 'loc', role: 'audio', codec: 'opus',
    samplerate: 48_000, channelConfig: '2', renderGroup: 1, altGroup: 3, isLive: true },
] }));
type Input = 'omitted' | 'undefined' | 'inherited undefined' | 'own undefined shadows inherited name' | 'custom' | 'empty' | 'unicode';
const expectedName = (input: Input) => input === 'custom' ? '.catalog' : input === 'empty' ? '' : input === 'unicode' ? 'catálogo' : 'catalog';

it('accepts public connection and player configurations that omit the catalog name', async () => {
  const connection: ConnectionConfig = { url: 'https://catalog.invalid/live', namespace };
  const options: MoqtPlayerConfig = connection;
  const player = new MoqtPlayer(options);
  await player.destroy();
  expect(connection).not.toHaveProperty('catalogTrackName');
});

async function fixture(draft: AudioDraft, input: Input) {
  const peers = [audioPeer(draft), audioPeer(draft)], scheduled: number[] = [], decoded: number[] = [], errors: string[] = [];
  let now = 10_000_000, transports = 0;
  const output: AudioOutputLike = { schedule(data) {
    if (typeof data !== 'object' || data === null || !('timestamp' in data) || typeof data.timestamp !== 'number') throw new Error('No decoded audio timestamp');
    scheduled.push(data.timestamp);
  }, currentPlayoutTimeUs: 0, flush() {}, destroy() {} };
  const decoder: AudioDecoderLike = { configure() {}, decode(chunk, at, receipt) {
    decoded.push(chunk.timestamp); decoder.onData?.({ timestamp: chunk.timestamp, close() {} }, at, receipt);
  }, flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null };
  const options: MoqtPlayerConfig = { url: 'https://catalog.invalid/live', namespace, draftVersion: draft,
    clock: { now: () => now }, catalogBootstrap: 'subscribe', disableVideo: true, autoQuality: false,
    cmafBootstrapTimeoutMs: 0, reconnectAttempts: 0, logLevel: 'none',
    createConnection: () => peers[0]!.client, createTransport: async () => peers[transports++]!.start(),
    createAudioDecoder: () => decoder, createAudioOutput: () => output,
  };
  if (input === 'inherited undefined') Object.setPrototypeOf(options, { catalogTrackName: undefined });
  if (input === 'own undefined shadows inherited name') Object.setPrototypeOf(options, { catalogTrackName: '.inherited' });
  if (input === 'undefined' || input === 'own undefined shadows inherited name') Reflect.set(options, 'catalogTrackName', undefined);
  if (input === 'custom' || input === 'empty' || input === 'unicode') Reflect.set(options, 'catalogTrackName', expectedName(input));
  const player = new MoqtPlayer(options);
  player.on('error', event => { errors.push(event.error.message); });
  const ref = { namespace, name: expectedName(input) };
  async function destroy() { await player.destroy(); for (const peer of peers) await peer.close(); }
  try { await player.load(); await flush(512); } catch (error) { await destroy(); throw error; }
  async function sendAudio(peer: typeof peers[number], object: bigint, pts: bigint) {
    await peer.send(media, Uint8Array.of(0x48, 21, Number(object)), 70n, object,
      encodeLocHeaders({ captureTimestamp: pts }, { wireProfile: locWireProfileForDraft(draft) }));
    now = Number(pts) + 20_000; player.tick(); await flush(512);
  }
  async function ready(peer: typeof peers[number], catalogRef: AudioRef, alias: bigint, object = 0n, pts = 10_000_000n) {
    await peer.accept(catalogRef, alias); await peer.send(catalogRef, catalog, 1n); await flush(512);
    await peer.accept(media, alias + 1n); await sendAudio(peer, object, pts);
  }
  return { player, peers, ref, decoded, scheduled, errors, ready, destroy,
    get transports() { return transports; } };
}

describe.each([18, 22] as const)('catalog name on real draft %s wire', draft => {
  it.each<Input>(['omitted', 'undefined', 'inherited undefined', 'own undefined shadows inherited name', 'custom', 'empty', 'unicode'])
  ('uses %s configuration without changing namespace bytes', async input => {
    const f = await fixture(draft, input);
    try {
      expect(f.peers[0]!.requests.map(({ namespace, name }) => ({ namespace, name }))).toEqual([f.ref]);
      await f.ready(f.peers[0]!, f.ref, 100n);
      expect(f.player.selection.audio).toEqual(identity(media));
      expect(f.decoded).toEqual([10_000_000]); expect(f.scheduled).toEqual([10_000_000]);
      expect(f.errors).toEqual([]); expect(f.peers[0]!.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it.each<Input>(['omitted', 'undefined', 'custom', 'empty'])('keeps the %s catalog identity through a real handover', async input => {
    const f = await fixture(draft, input);
    try {
      expect(f.peers[0]!.requests.map(({ name }) => name)).toEqual([f.ref.name]);
      await f.ready(f.peers[0]!, f.ref, 100n);
      const next = f.peers[1]!, migrating = f.player.migrate(next.client);
      const state: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' };
      void migrating.then(() => { state.status = 'fulfilled'; }, error => { state.status = 'rejected'; state.error = error; });
      await flush(512);
      expect(next.requests.map(({ namespace, name }) => ({ namespace, name }))).toEqual([f.ref]);
      await f.ready(next, f.ref, 500n, 1n, 10_040_000n);
      expect(state.status, String(state.error)).toBe('fulfilled'); await migrating;
      expect(f.player.selection.audio).toEqual(identity(media));
      expect(f.decoded).toEqual([10_000_000, 10_040_000]); expect(f.scheduled).toEqual([10_000_000, 10_040_000]);
      expect(f.transports).toBe(2); expect(f.errors).toEqual([]); expect(next.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
