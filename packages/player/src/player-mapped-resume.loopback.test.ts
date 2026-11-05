import { it, expect } from 'vitest';
import { mediaSelectionFixture, mediaRefs, mediaTracks } from '../test-support/media-selection.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { audioSelectionFixture, refs } from '../test-support/audio-selection.js';

it.each(['loc', 'locmaf-frame'] as const)('resumes an explicit audio map installed by selectAudioTrack on %s', async path => {
  const f = await audioSelectionFixture(18, { path, crossSet: true });
  try {
    f.player.play(); void f.player.audioTimelineReference;
    await f.sendAudio('english', 70n, 1n, 10_040_000n); f.tick(1); await flush(512);
    const reference = f.player.audioTimelineReference;
    if (!reference) throw new Error('No accepted audio reference');
    const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map', referenceToken: reference.token,
      sourceTimeUs: 90_000_000n, referenceTimeUs: 10_000_000n } });
    await flush(512); await f.wire.accept(refs.spanish, 301n);
    await f.sendAudio('spanish', 300n, 0n, 90_080_000n); f.tick(1); await selecting;
    const audio = f.scheduledAudio.length, video = f.renderedVideo.length;
    f.wire.server.setLargestLocationProvider(id => ({
      group: f.wire.requests.find(request => request.id === id)?.name === refs.spanish.name ? 300n : 800n, object: 0n,
    }));
    f.player.pause(); await flush(512); f.player.play(); await flush(512);
    await f.sendAudio('spanish', 301n, 0n, 90_100_000n);
    await f.wire.send(refs.video, Uint8Array.of(0, 0, 0, 1, 0x65), 801n, 0n,
      encodeLocHeaders({ captureTimestamp: 10_100_000n }, { wireProfile: locWireProfileForDraft(18) }));
    f.tick(1); await flush(512);
    expect(f.scheduledAudio.length).toBeGreaterThan(audio);
    expect(f.renderedVideo.length).toBeGreaterThan(video);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});

it.each(['program', 'video-only', 'view'] as const)('output resumes after mapped %s selection', async mode => {
  const f = await mediaSelectionFixture(18, { videoOnly: mode === 'video-only' });
  try {
    f.player.play();
    void f.player.mediaTimelineReference;
    await f.sendOld(10_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const program = mode === 'program';
    const selecting = f.player.selectMedia(program
      ? { renderGroup: 2, videoTrack: mediaRefs.nextVideo, audioTrack: mediaRefs.nextAudio }
      : { videoTrack: mediaRefs.viewVideo },
      { timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: program ? 90_000_000n : 700_000_000n, referenceTimeUs: 10_000_000n },
        ...(program ? { audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } : {}) } });
    await flush(512);
    await f.accept(program ? 'nextVideo' : 'viewVideo');
    if (program) await f.accept('nextAudio');
    await f.send(program ? 'nextVideo' : 'viewVideo', program ? 90_080_000n : 700_080_000n);
    if (program) await f.send('nextAudio', 900_080_000n);
    await selecting; f.tick(0); await flush(512);
    expect(f.enqueuedVideo.at(-1)?.key).toBe(program ? 'nextVideo' : 'viewVideo');
    const videos = f.enqueuedVideo.length, audios = f.scheduledAudio.length;
    f.wire.server.setLargestLocationProvider(id => {
      const req = f.wire.requests.find(req => req.id === id);
      const key = (Object.keys(mediaTracks) as Array<keyof typeof mediaTracks>).find(key =>
        req?.name === mediaRefs[key].name && JSON.stringify(req.namespace) === JSON.stringify(mediaRefs[key].namespace));
      return { group: key ? mediaTracks[key].group : 1n, object: key === 'oldAudio' || key === 'oldVideo' ? 1n : 0n };
    });
    f.player.pause(); await flush(512); f.player.play(); await flush(512);
    async function fresh(key: keyof typeof mediaTracks, pts: bigint) {
      const track = mediaTracks[key];
      const extensions = encodeLocHeaders({ timestamp: pts * track.scale / 1_000_000n, timescale: track.scale,
        ...(track.media === 'video' ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) });
      const payload = track.media === 'video' ? Uint8Array.of(0,0,0,1,0x65,track.marker) : Uint8Array.of(0x48,track.marker,0);
      await f.wire.send(mediaRefs[key], payload, track.group + 1n, 0n, extensions);
    }
    if (mode === 'view') await fresh('oldAudio', 10_100_000n);
    if (program) await fresh('nextAudio', 900_100_000n);
    await fresh(program ? 'nextVideo' : 'viewVideo', program ? 90_100_000n : 700_100_000n);
    f.tick(); await flush(512);
    expect(f.enqueuedVideo.length).toBeGreaterThan(videos);
    if (program) expect(f.scheduledAudio.length).toBeGreaterThan(audios);
  } finally { await f.destroy(); }
});

it.each(['program', 'video-only'] as const)('held pre-pause adopted input cannot establish mapped %s resume clock', async mode => {
  const f = await mediaSelectionFixture(18, { videoOnly: mode === 'video-only' });
  try {
    f.player.play();
    void f.player.mediaTimelineReference;
    await f.sendOld(10_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const program = mode === 'program';
    const selecting = f.player.selectMedia(program
      ? { renderGroup: 2, videoTrack: mediaRefs.nextVideo, audioTrack: mediaRefs.nextAudio }
      : { videoTrack: mediaRefs.viewVideo },
      { timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: program ? 90_000_000n : 700_000_000n, referenceTimeUs: 10_000_000n },
        ...(program ? { audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } : {}) } });
    await flush(512);
    await f.accept(program ? 'nextVideo' : 'viewVideo');
    if (program) await f.accept('nextAudio');
    await f.send(program ? 'nextVideo' : 'viewVideo', program ? 90_080_000n : 700_080_000n);
    if (program) await f.send('nextAudio', 900_080_000n);
    await selecting; f.tick(0); await flush(512);
    expect(f.enqueuedVideo.at(-1)?.key).toBe(program ? 'nextVideo' : 'viewVideo');
    const master = program ? 'nextAudio' : 'viewVideo';
    const masterTrack = mediaTracks[master];
    const origin = program ? 900_000_000n : 700_000_000n;
    const release = f.hold(master);
    async function fresh(key: keyof typeof mediaTracks, pts: bigint, group: bigint) {
      const track = mediaTracks[key];
      const extensions = encodeLocHeaders({ timestamp: pts * track.scale / 1_000_000n, timescale: track.scale,
        ...(track.media === 'video' ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) });
      const payload = track.media === 'video' ? Uint8Array.of(0,0,0,1,0x65,track.marker) : Uint8Array.of(0x48,track.marker,0);
      await f.wire.send(mediaRefs[key], payload, group, 0n, extensions);
    }
    await fresh(master, origin + 100_000n, masterTrack.group + 1n);
    const before = program ? f.scheduledAudio.length : f.enqueuedVideo.length;
    f.wire.server.setLargestLocationProvider(id => {
      const req = f.wire.requests.find(req => req.id === id);
      const key = (Object.keys(mediaTracks) as Array<keyof typeof mediaTracks>).find(key =>
        req?.name === mediaRefs[key].name && JSON.stringify(req.namespace) === JSON.stringify(mediaRefs[key].namespace));
      return { group: key ? mediaTracks[key].group + (key === master ? 1n : 0n) : 1n, object: 0n };
    });
    f.player.pause(); await flush(512);
    const now = f.clock.now;
    f.clock.now = () => now() + 10_000_000;
    f.player.play(); await flush(512);
    release(); await flush(512); f.tick(0); await flush(512);
    const afterHeld = program ? f.scheduledAudio.length : f.enqueuedVideo.length;
    expect(afterHeld).toBe(before);
    // The held subgroup was discarded, so resume at a fresh independent group.
    await fresh(master, origin + 10_100_000n, masterTrack.group + 2n);
    f.tick(0); await flush(512);
    const points = program ? f.scheduledAudio : f.enqueuedVideo;

    expect(points.at(-1)?.rawTimestampUs).toBe(Number(origin + 10_100_000n));
    expect(points.at(-1)!.renderTimeUs - f.clock.now()).toBeLessThan(500_000);
  } finally { await f.destroy(); }
});

it.each(['program', 'video-only', 'view'] as const)('output recovers after a native stall with mapped %s selection', async mode => {
  const f = await mediaSelectionFixture(18, { videoOnly: mode === 'video-only' });
  try {
    f.player.play();
    void f.player.mediaTimelineReference;
    await f.sendOld(10_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const program = mode === 'program';
    const selecting = f.player.selectMedia(program
      ? { renderGroup: 2, videoTrack: mediaRefs.nextVideo, audioTrack: mediaRefs.nextAudio }
      : { videoTrack: mediaRefs.viewVideo },
      { timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: program ? 90_000_000n : 700_000_000n, referenceTimeUs: 10_000_000n },
        ...(program ? { audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } : {}) } });
    await flush(512);
    await f.accept(program ? 'nextVideo' : 'viewVideo');
    if (program) await f.accept('nextAudio');
    await f.send(program ? 'nextVideo' : 'viewVideo', program ? 90_080_000n : 700_080_000n);
    if (program) await f.send('nextAudio', 900_080_000n);
    await selecting; f.tick(0); await flush(512);
    expect(f.enqueuedVideo.at(-1)?.key).toBe(program ? 'nextVideo' : 'viewVideo');
    const videos = f.enqueuedVideo.length, audios = f.scheduledAudio.length;
    f.wire.server.setLargestLocationProvider(id => {
      const req = f.wire.requests.find(req => req.id === id);
      const key = (Object.keys(mediaTracks) as Array<keyof typeof mediaTracks>).find(key =>
        req?.name === mediaRefs[key].name && JSON.stringify(req.namespace) === JSON.stringify(mediaRefs[key].namespace));
      return { group: key ? mediaTracks[key].group : 1n, object: key === 'oldAudio' || key === 'oldVideo' ? 1n : 0n };
    });
    expect(f.renderer.onStall).toBeTypeOf('function'); f.renderer.onStall?.(250); await flush(512);
    async function fresh(key: keyof typeof mediaTracks, pts: bigint) {
      const track = mediaTracks[key];
      const extensions = encodeLocHeaders({ timestamp: pts * track.scale / 1_000_000n, timescale: track.scale,
        ...(track.media === 'video' ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) });
      const payload = track.media === 'video' ? Uint8Array.of(0,0,0,1,0x65,track.marker) : Uint8Array.of(0x48,track.marker,0);
      await f.wire.send(mediaRefs[key], payload, track.group + 1n, 0n, extensions);
    }
    if (mode === 'view') await fresh('oldAudio', 10_100_000n);
    if (program) await fresh('nextAudio', 900_100_000n);
    await fresh(program ? 'nextVideo' : 'viewVideo', program ? 90_100_000n : 700_100_000n);
    f.tick(); await flush(512);

    expect(f.enqueuedVideo.length).toBeGreaterThan(videos);
    if (program) expect(f.scheduledAudio.length).toBeGreaterThan(audios);
  } finally { await f.destroy(); }
});

it.each(['program', 'video-only'] as const)('clock callback reset cannot install a retired mapped %s input baseline', async mode => {
  const f = await mediaSelectionFixture(18, { videoOnly: mode === 'video-only' });
  try {
    f.player.play();
    void f.player.mediaTimelineReference;
    await f.sendOld(10_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const program = mode === 'program';
    const selecting = f.player.selectMedia(program
      ? { renderGroup: 2, videoTrack: mediaRefs.nextVideo, audioTrack: mediaRefs.nextAudio }
      : { videoTrack: mediaRefs.viewVideo },
      { timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: program ? 90_000_000n : 700_000_000n, referenceTimeUs: 10_000_000n },
        ...(program ? { audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } : {}) } });
    await flush(512);
    await f.accept(program ? 'nextVideo' : 'viewVideo');
    if (program) await f.accept('nextAudio');
    await f.send(program ? 'nextVideo' : 'viewVideo', program ? 90_080_000n : 700_080_000n);
    if (program) await f.send('nextAudio', 900_080_000n);
    await selecting; f.tick(0); await flush(512);
    expect(f.enqueuedVideo.at(-1)?.key).toBe(program ? 'nextVideo' : 'viewVideo');
    const master = program ? 'nextAudio' : 'viewVideo';
    const masterTrack = mediaTracks[master];
    const origin = program ? 900_000_000n : 700_000_000n;
    async function fresh(key: keyof typeof mediaTracks, pts: bigint, group: bigint) {
      const track = mediaTracks[key];
      const extensions = encodeLocHeaders({ timestamp: pts * track.scale / 1_000_000n, timescale: track.scale,
        ...(track.media === 'video' ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) });
      const payload = track.media === 'video' ? Uint8Array.of(0,0,0,1,0x65,track.marker) : Uint8Array.of(0x48,track.marker,0);
      await f.wire.send(mediaRefs[key], payload, group, 0n, extensions);
    }
    f.wire.server.setLargestLocationProvider(id => {
      const req = f.wire.requests.find(req => req.id === id);
      const key = (Object.keys(mediaTracks) as Array<keyof typeof mediaTracks>).find(key =>
        req?.name === mediaRefs[key].name && JSON.stringify(req.namespace) === JSON.stringify(mediaRefs[key].namespace));
      return { group: key ? mediaTracks[key].group + (key === master ? 1n : 0n) : 1n, object: 0n };
    });
    f.player.pause(); await flush(512); f.player.play(); await flush(512);
    const now = f.clock.now;
    let reentered = false, jump = 0;
    f.clock.now = () => {
      if (!reentered && /SyncController\.set(?:Audio|Video)Reference/.test(new Error().stack ?? '')) {
        reentered = true;
        f.player.pause(); jump = 10_000_000; f.player.play();
      }
      return now() + jump;
    };
    const before = program ? f.scheduledAudio.length : f.enqueuedVideo.length;
    await fresh(master, origin + 100_000n, masterTrack.group + 1n);
    f.tick(0); await flush(512);
    expect(reentered).toBe(true);
    const afterOld = program ? f.scheduledAudio.length : f.enqueuedVideo.length;
    expect(afterOld).toBe(before);
    await fresh(master, origin + 10_100_000n, masterTrack.group + 2n);
    f.tick(0); await flush(512);
    const points = program ? f.scheduledAudio : f.enqueuedVideo;

    expect(points.at(-1)?.rawTimestampUs).toBe(Number(origin + 10_100_000n));
    expect(points.at(-1)!.renderTimeUs - f.clock.now()).toBeLessThan(500_000);
  } finally { await f.destroy(); }
});

it.each(['program', 'video-only'] as const)('media object callback reset cannot admit a retired mapped %s input', async mode => {
  const f = await mediaSelectionFixture(18, { videoOnly: mode === 'video-only' });
  try {
    f.player.play();
    void f.player.mediaTimelineReference;
    await f.sendOld(10_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const program = mode === 'program';
    const selecting = f.player.selectMedia(program
      ? { renderGroup: 2, videoTrack: mediaRefs.nextVideo, audioTrack: mediaRefs.nextAudio }
      : { videoTrack: mediaRefs.viewVideo },
      { timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: program ? 90_000_000n : 700_000_000n, referenceTimeUs: 10_000_000n },
        ...(program ? { audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } : {}) } });
    await flush(512);
    await f.accept(program ? 'nextVideo' : 'viewVideo');
    if (program) await f.accept('nextAudio');
    await f.send(program ? 'nextVideo' : 'viewVideo', program ? 90_080_000n : 700_080_000n);
    if (program) await f.send('nextAudio', 900_080_000n);
    await selecting; f.tick(0); await flush(512);
    expect(f.enqueuedVideo.at(-1)?.key).toBe(program ? 'nextVideo' : 'viewVideo');
    const master = program ? 'nextAudio' : 'viewVideo';
    const masterTrack = mediaTracks[master];
    const origin = program ? 900_000_000n : 700_000_000n;
    async function fresh(key: keyof typeof mediaTracks, pts: bigint, group: bigint) {
      const track = mediaTracks[key];
      const extensions = encodeLocHeaders({ timestamp: pts * track.scale / 1_000_000n, timescale: track.scale,
        ...(track.media === 'video' ? { videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } } : {}) }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) });
      const payload = track.media === 'video' ? Uint8Array.of(0,0,0,1,0x65,track.marker) : Uint8Array.of(0x48,track.marker,0);
      await f.wire.send(mediaRefs[key], payload, group, 0n, extensions);
    }
    f.wire.server.setLargestLocationProvider(id => {
      const req = f.wire.requests.find(req => req.id === id);
      const key = (Object.keys(mediaTracks) as Array<keyof typeof mediaTracks>).find(key =>
        req?.name === mediaRefs[key].name && JSON.stringify(req.namespace) === JSON.stringify(mediaRefs[key].namespace));
      return { group: key ? mediaTracks[key].group + (key === master ? 1n : 0n) : 1n, object: 0n };
    });
    const now = f.clock.now;
    let reentered = false, jump = 0;
    f.clock.now = () => now() + jump;
    f.player.on('media_object', event => {
      if (reentered || event.mediaType !== masterTrack.media || event.groupId !== masterTrack.group + 1n) return;
      reentered = true;
      f.player.pause(); jump = 10_000_000; f.player.play();
    });
    const before = program ? f.scheduledAudio.length : f.enqueuedVideo.length;
    await fresh(master, origin + 100_000n, masterTrack.group + 1n);
    f.tick(0); await flush(512);
    expect(reentered).toBe(true);
    const afterOld = program ? f.scheduledAudio.length : f.enqueuedVideo.length;
    expect.soft(afterOld, 'retired input reached output after its media_object callback reset').toBe(before);
    await fresh(master, origin + 10_100_000n, masterTrack.group + 2n);
    f.tick(0); await flush(512);
    const points = program ? f.scheduledAudio : f.enqueuedVideo;

    expect(points.at(-1)?.rawTimestampUs).toBe(Number(origin + 10_100_000n));
    expect(points.at(-1)!.renderTimeUs - f.clock.now()).toBeLessThan(500_000);
  } finally { await f.destroy(); }
});
