/** Real SDK peer priorities; scheduling preferences, not throughput or audible-output claims. */
import { describe, expect, it } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { audioPeer, audioSelectionFixture, refs, type AudioRef } from '../test-support/audio-selection.js';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';

type AudioPolicy = Partial<Pick<MoqtPlayerConfig, 'subscriberPriority' | 'audioSubscriberPriority'>>;
const cases: Array<{ name: string; config: AudioPolicy; video: bigint; audio: bigint }> = [
  { name: 'default', config: {}, video: 128n, audio: 126n },
  { name: 'base64', config: { subscriberPriority: 64 }, video: 64n, audio: 62n },
  { name: 'base1 clamp', config: { subscriberPriority: 1 }, video: 1n, audio: 0n },
  { name: 'base0 tie', config: { subscriberPriority: 0 }, video: 0n, audio: 0n },
  { name: 'base255', config: { subscriberPriority: 255 }, video: 255n, audio: 253n },
  { name: 'override0', config: { subscriberPriority: 64, audioSubscriberPriority: 0 }, video: 64n, audio: 0n },
  { name: 'override255', config: { subscriberPriority: 64, audioSubscriberPriority: 255 }, video: 64n, audio: 255n },
];
type Fixture = Awaited<ReturnType<typeof audioSelectionFixture>>;
function receivedPriority(f: Fixture, ref: AudioRef): bigint {
  const request = f.wire.request(ref);
  const priority = f.wire.priorities.get(request.id);
  if (priority === undefined) throw new Error('Peer lacks its decoded SUBSCRIBE priority');
  return priority;
}

describe.each([16, 18, 22] as const)('draft%d audio subscription priority', draft => {
  it.each(cases)('$name reaches the peer without changing video/catalog priority', async ({ config, video, audio }) => {
    const f = await audioSelectionFixture(draft, { path: 'loc', config });
    try {
      expect(receivedPriority(f, refs.video)).toBe(video);
      expect(receivedPriority(f, refs.catalog)).toBe(128n);
      expect(receivedPriority(f, refs.english)).toBe(audio);
      expect(f.errors).toEqual([]);
      expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('selected replacement audio preserves the policy and the existing video request', async () => {
    const f = await audioSelectionFixture(draft, { path: 'loc', config: { subscriberPriority: 64 } });
    let selecting: Promise<void> | undefined;
    try {
      const videoId = f.wire.request(refs.video).id;
      selecting = f.player.selectAudioTrack(refs.spanish);
      void selecting.catch(() => {});
      await flush(512);
      await f.wire.accept(refs.spanish, 301n);
      await f.sendAudio('spanish', 70n, 2n, 10_040_000n);
      f.tick(1);
      await flush(512);
      await selecting;
      expect(f.player.selection.audio?.name).toBe(refs.spanish.name);
      expect(f.scheduledAudio.at(-1)?.timestamp).toBe(10_040_000);
      expect(f.wire.request(refs.video).id).toBe(videoId);
      expect(receivedPriority(f, refs.video)).toBe(64n);
      expect(receivedPriority(f, refs.spanish)).toBe(62n);
      expect(f.errors).toEqual([]);
      expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); await selecting?.catch(() => {}); }
  });
});

it('replacement audio init retains ordinary priority instead of the audio override', async () => {
  const f = await audioSelectionFixture(18, {
    path: 'cmaf', config: { subscriberPriority: 64, audioSubscriberPriority: 0 },
  });
  let migrating: Promise<void> | undefined;
  try {
    const next = f.peers[1]!;
    migrating = f.player.migrate(next.client);
    void migrating.catch(() => {});
    await flush(512);
    await next.accept(refs.catalog, 500n);
    const catalog: { version: string | number; tracks: Array<{
      name: string; namespace: string; initData?: string; initTrack?: string;
    }> } = JSON.parse(new TextDecoder().decode(f.catalog));
    catalog.version = 'draft-01';
    const audio = catalog.tracks.find(track => track.name === refs.english.name)!;
    delete audio.initData;
    audio.initTrack = 'audio-init';
    await next.send(refs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 1n);
    await flush(512);
    const init = next.request({ name: 'audio-init', namespace: refs.english.namespace });
    const media = next.request(refs.english);
    expect(next.priorities.get(init.id)).toBe(128n);
    expect(next.priorities.get(media.id)).toBe(0n);
    expect(next.priorities.get(next.request(refs.catalog).id)).toBe(128n);
    expect(next.errors).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); await migrating?.catch(() => {}); }
});

describe.each([16, 18, 22] as const)('draft%d remaining audio priority paths', draft => {
  it('known-track audio carries the override before any catalog arrives', async () => {
    const wire = audioPeer(draft);
    const player = new MoqtPlayer({
      url: 'https://audio.invalid/live', namespace: ['known'], draftVersion: draft,
      knownTracks: { audio: { name: 'audio', codec: 'opus' } }, disableVideo: true,
      subscriberPriority: 64, audioSubscriberPriority: 7,
      createConnection: () => wire.client, createTransport: async () => wire.start(),
    });
    try {
      await player.load(); await flush(512);
      const request = wire.request({ name: 'audio', namespace: ['known'] });
      expect(wire.priorities.get(request.id)).toBe(7n);
      expect(wire.errors).toEqual([]);
    } finally { await player.destroy(); await wire.close(); }
  });

  it('auxiliary audio carries the override on its own SUBSCRIBE', async () => {
    const f = await audioSelectionFixture(draft, { path: 'loc', config: { audioSubscriberPriority: 7 } });
    try {
      // Exercise the owned auxiliary helper directly: current public auxiliary
      // callers use init/timeline media, so they cannot witness its audio branch.
      const owner = f.player as unknown as {
        subscribeAuxTrackOwned(ns: Uint8Array[], name: Uint8Array, options: object,
          info: { trackName: string; mediaType: 'audio'; packaging: 'loc' }): Promise<bigint | undefined>;
      };
      const id = await owner.subscribeAuxTrackOwned([new TextEncoder().encode('aux')],
        new TextEncoder().encode('audio'), {}, { trackName: 'audio', mediaType: 'audio', packaging: 'loc' });
      await flush(512);
      expect(f.wire.request({ name: 'audio', namespace: ['aux'] }).id).toBe(id);
      expect(f.wire.priorities.get(id!)).toBe(7n);
      expect(f.wire.errors).toEqual([]);
    } finally { await f.destroy(); }
  });
});
