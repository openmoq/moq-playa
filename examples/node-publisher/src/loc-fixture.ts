import { encodeLocHeaders, type LocVersion } from '@openmoq/loc';
import { parseLocmafTrackContext, parseCmafChunk, sliceFrames, codecDescriptionFromInit, ticksToMicros } from '@openmoq/locmaf';
import { buildCatalog } from '@openmoq/msf';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { LoadedTrack, LoadedFixture } from './fixture.js';
import { establishTrack, publishObjects } from './publisher.js';

interface LocFrame {
  offsetTicks: bigint;
  payload: Uint8Array;
  independent: boolean;
}

/** Prepared no-B-frame H.264/Opus signals, split into LOC elementary frames. */
export function prepareLocTrack(track: LoadedTrack) {
  const context = parseLocmafTrackContext(track.initData);
  const video = track.meta.role === 'video';
  if (context.isProtected || context.timescale <= 0
    || (video && (context.handlerType !== 'vide' || context.codecFourcc !== 'avc1' || !track.meta.codec.startsWith('avc1.')))
    || (!video && (track.meta.role !== 'audio' || context.handlerType !== 'soun' || context.codecFourcc !== 'Opus' || track.meta.codec !== 'opus' || context.timescale !== 48000))) {
    throw new Error(`${track.meta.name}: LOC fixture requires H.264 video or Opus audio`);
  }
  const videoConfig = video ? codecDescriptionFromInit(track.initData) : null;
  if (video && !videoConfig) throw new Error(`${track.meta.name}: missing AVC decoder configuration`);
  const groups: { frames: LocFrame[] }[] = [];
  let firstDecode: bigint | undefined;
  let nextDecode: bigint | undefined;
  const frames = track.chunks.flatMap((chunk) => {
    const parsed = parseCmafChunk(chunk, context);
    if (!parsed.fits) throw new Error(`${track.meta.name}: unsupported prepared chunk`);
    return sliceFrames(parsed.effective, parsed.mdat);
  });
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    if (frame.duration <= 0 || (nextDecode !== undefined && frame.decodeTime !== nextDecode)) {
      throw new Error(`${track.meta.name}: samples must be contiguous with positive durations`);
    }
    if (frame.presentationTime !== frame.decodeTime) throw new Error(`${track.meta.name}: composition offsets are not supported by this fixture publisher`);
    firstDecode ??= frame.decodeTime;
    if (!video) {
      // This fixture uses one 20ms CELT frame/packet (RFC 6716 3.1/3.2.2).
      const toc = frame.data[0];
      if (toc === undefined || (toc >> 3) < 16 || ((toc >> 3) & 3) !== 3 || (toc & 3) !== 0
        || (frame.duration !== 960 && !(i === frames.length - 1 && frame.duration < 960))) {
        throw new Error(`${track.meta.name}: fixture requires single-frame 20ms Opus packets`);
      }
    }
    // MP4 can trim its final packet. LOC carries the full elementary packet,
    // so the next loop must start after all 960 decoded samples, not the trim.
    nextDecode = frame.decodeTime + BigInt(video ? frame.duration : 960);
    if (!video || frame.isSync) groups.push({ frames: [] });
    if (!groups.length) throw new Error(`${track.meta.name}: video must begin with an independent sample`);
    groups.at(-1)!.frames.push({ offsetTicks: frame.decodeTime - firstDecode, payload: frame.data,
      independent: video ? frame.isSync : true });
  }
  if (!groups.length) throw new Error(`${track.meta.name}: no encoded samples`);
  return { name: track.meta.name, video, groups, timescale: context.timescale,
    spanTicks: nextDecode! - firstDecode!, videoConfig };
}

export function locFrameProperties(track: ReturnType<typeof prepareLocTrack>, frame: Pick<LocFrame, 'offsetTicks' | 'independent'>,
  loop: number, version: LocVersion, mode: 'wall-clock' | 'media', epochUs: bigint): Uint8Array {
  if (version === 1 && mode === 'media') throw new Error('LOC-01 requires wall-clock timestamps');
  const ticks = frame.offsetTicks + BigInt(loop) * track.spanTicks;
  return encodeLocHeaders({
    ...(mode === 'media' ? { timestamp: ticks, timescale: BigInt(track.timescale), timestampIsWallClock: false }
      : { captureTimestamp: epochUs + ticksToMicros(ticks, track.timescale) }),
    ...(track.video ? {
      videoFrameMarking: { independent: frame.independent, startOfFrame: true, endOfFrame: true,
        discardable: false, baseLayerSync: false, temporalId: 0 },
      ...(frame.independent ? { videoConfig: track.videoConfig! } : {}),
    } : {}),
  }, { locVersion: version, wireProfile: 'd18-delta-vi64' })!;
}

/** GOP group numbering with one stream per object, as MSF-01 section 6 requires. */
export async function publishLocFixture(conn: MoqtConnection, fixture: LoadedFixture, version: LocVersion,
  mode: 'wall-clock' | 'media', loops = Infinity): Promise<void> {
  if (version === 1 && mode === 'media') throw new Error('LOC-01 requires wall-clock timestamps');
  const tracks = fixture.tracks.map(prepareLocTrack);
  const catalog = buildCatalog({ version: '1', tracks: fixture.tracks.map(({ meta }) => ({
    ...meta, packaging: 'loc', isLive: true, renderGroup: fixture.manifest.renderGroup,
  })) });
  await publishObjects(conn, fixture.manifest.namespace, 'catalog', 10n, [catalog], 0);
  for (let i = 0; i < tracks.length; i++) {
    await establishTrack(conn, fixture.manifest.namespace, tracks[i]!.name, BigInt(11 + i));
  }
  const startMs = performance.now();
  const epochUs = BigInt(Date.now()) * 1000n;
  console.log(`[publisher] loop mode: ${tracks.length} tracks established; LOC-${version} ${mode}; epoch_us=${epochUs}`);
  const waitUntil = async (target: number) => {
    const delay = target - performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  };
  await Promise.all(tracks.map(async (track, index) => {
    const ms = (ticks: bigint) => Number(ticks) / track.timescale * 1000;
    for (let loop = 0; loop < loops; loop++) {
      for (let g = 0; g < track.groups.length; g++) {
        const group = track.groups[g]!;
        await waitUntil(startMs + ms(BigInt(loop) * track.spanTicks + group.frames[0]!.offsetTicks));
        for (let object = 0; object < group.frames.length; object++) {
          const frame = group.frames[object]!;
          await waitUntil(startMs + ms(BigInt(loop) * track.spanTicks + frame.offsetTicks));
          const stream = await conn.openSubgroup(BigInt(11 + index), BigInt(loop * track.groups.length + g), BigInt(object), {
            hasExtensions: true, firstObject: true, endOfGroup: object === group.frames.length - 1, publisherPriority: track.video ? 128 : 64,
          });
          await conn.sendObject(stream, BigInt(object), frame.payload, locFrameProperties(track, frame, loop, version, mode, epochUs));
          await conn.closeSubgroup(stream);
        }
      }
      await waitUntil(startMs + ms(BigInt(loop + 1) * track.spanTicks));
    }
  }));
}
