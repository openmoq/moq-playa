import { publicationState } from '../../shared/publication-state.js';
/**
 * Publish a LoadedFixture into the relay over MoQT draft-18, using public APIs only:
 *
 *   1. catalog track first — `buildCatalog()` with each track's metadata and base64
 *      initData; one object (group 0, object 0).
 *   2. each media track — one PUBLISH, then one object per chunk. CMAF uses one
 *      subgroup per object (MSF section 6); LOCMAF uses one per group (LOCMAF section 3).
 *
 * Pacing: `paceMs > 0` sleeps between chunks (timestamp-style pacing for a live
 * demo); the smoke uses 0 (as fast as possible).
 */
import { buildCatalog, CATALOG_TRACK_NAME } from '@openmoq/msf';
import { LOCMAF_VERSION } from '@openmoq/locmaf';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { LoadedFixture, LoadedTrack } from './fixture.js';
import { TrackObjectSource, type MediaPackaging } from './track-packager.js';
import { analyzeCmafTimeline, firstFragmentBmd, type CmafTimeline } from './cmaf-loop-rebase.js';

export type { MediaPackaging } from './track-packager.js';

/**
 * Catalog wire shape to emit:
 *  - `msf-00` (CMAF default): numeric `version: 1`, inline per-track base64 `initData`.
 *  - `cmsf-01`: string `version: "1"`, a root `initDataList`, and per-track
 *    `initRef` (the modern MSF-01/CMSF-01 init-by-reference form Playa resolves).
 */
export type CatalogFormat = 'msf-00' | 'cmsf-01';

/** Root initDataList entry id for a track (cmsf-01 mode). */
const initEntryId = (trackName: string) => `${trackName}-init`;

const log = (...a: unknown[]) => console.log('[publisher]', ...a);
const te = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for our PUBLISH to be accepted (REQUEST_OK for this request id) so the relay
 *  has attached its object handler before we send. Restores onMessage afterwards. */
function waitForPublishAccept(conn: MoqtConnection, requestId: bigint, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const prev = conn.onMessage;
    const restore = () => { conn.onMessage = prev ?? (() => { /* no prior handler */ }); };
    const timer = setTimeout(() => { restore(); reject(new Error(`PUBLISH ${requestId} not accepted in time`)); }, timeoutMs);
    conn.onMessage = (m) => {
      prev?.(m);
      if (m.type === 'REQUEST_OK' && (m as { requestId?: bigint }).requestId === requestId) {
        clearTimeout(timer); restore(); resolve();
      }
    };
  });
}

/** PUBLISH a track (request + acceptance) ONCE; group sends reuse the alias. */
export async function establishTrack(
  conn: MoqtConnection,
  namespace: readonly string[],
  track: string,
  alias: bigint,
): Promise<void> {
  const ns = namespace.map((p) => te.encode(p));
  const state = publicationState(conn);
  state.prepare(alias);
  const requestId = await conn.publish(ns, te.encode(track), alias);
  await waitForPublishAccept(conn, requestId);
}

/**
 * Send one group. LOCMAF keeps delta-dependent objects on one ordered stream;
 * CMAF uses one stream per object (MSF section 6).
 * FIRST_OBJECT describes the first object in each subgroup, not object ID zero.
 */
async function sendGroup(
  conn: MoqtConnection,
  alias: bigint,
  groupId: bigint,
  objects: readonly Uint8Array[],
  paceMs: number,
  opts: { timeline?: CmafTimeline; startMs?: number; packaging?: MediaPackaging } = {},
): Promise<void> {
  const waitUntil = async (target: number) => {
    const delay = target - performance.now();
    if (delay > 0) await sleep(delay);
  };
  const sharedStream = opts.packaging === 'locmaf' && objects.length > 0
    ? await conn.openSubgroup(alias, groupId, 0n, {
        publisherPriority: 128, firstObject: true, endOfGroup: true,
      })
    : null;
  for (let i = 0; i < objects.length; i++) {
    if (opts.timeline) await waitUntil(opts.startMs! + opts.timeline.offsetsMs[i]!);
    const sid = sharedStream ?? await conn.openSubgroup(alias, groupId, BigInt(i), {
      publisherPriority: 128, firstObject: true, endOfGroup: i === objects.length - 1,
    });
    publicationState(conn).sent(alias, groupId, BigInt(i));
    await conn.sendObject(sid, BigInt(i), objects[i]!);
    if (sharedStream === null) await conn.closeSubgroup(sid);
    if (!opts.timeline && paceMs > 0 && i < objects.length - 1) await sleep(paceMs);
  }
  if (sharedStream !== null) await conn.closeSubgroup(sharedStream);
  if (opts.timeline) await waitUntil(opts.startMs! + opts.timeline.durationMs);
}

/** PUBLISH one track and send `objects` as group 0 / objects 0..N-1 (one-shot). */
export async function publishObjects(
  conn: MoqtConnection,
  namespace: readonly string[],
  track: string,
  alias: bigint,
  objects: readonly Uint8Array[],
  paceMs: number,
): Promise<void> {
  await establishTrack(conn, namespace, track, alias);
  await sendGroup(conn, alias, 0n, objects, paceMs);
  log(`published ${track}: ${objects.length} object(s) (alias=${alias})`);
}

/**
 * Map fixture metadata → MSF catalog bytes. In `msf-00` mode each init segment
 * rides inline as base64 `initData`; in `cmsf-01` mode the init segments become a
 * root `initDataList` and tracks reference them by `initRef` (no per-track inline
 * init). Both are built with the same @openmoq/msf `buildCatalog`.
 *
 * `packaging` `locmaf` signals every track as `packaging: "locmaf"` with
 * `locmafVersion` (draft-einarsson-moq-locmaf-01 section 5); the init is
 * referenced through the CMSF initDataList/initRef form required by section 6.
 */
export function buildFixtureCatalog(
  fixture: LoadedFixture,
  format: CatalogFormat = 'msf-00',
  packaging: MediaPackaging = 'cmaf',
): Uint8Array {
  if (packaging === 'locmaf' && format !== 'cmsf-01') {
    throw new Error('LOCMAF publication requires a CMSF-01 catalog with initDataList/initRef');
  }
  const common = (t: LoadedTrack) => ({
    name: t.meta.name,
    ...(packaging === 'locmaf'
      ? { packaging: 'locmaf' as const, locmafVersion: LOCMAF_VERSION }
      : { packaging: t.meta.packaging }),
    isLive: true as const,
    role: t.meta.role,
    codec: t.meta.codec,
    renderGroup: t.meta.renderGroup ?? fixture.manifest.renderGroup,
    ...(t.meta.altGroup !== undefined ? { altGroup: t.meta.altGroup } : {}),
    ...(t.meta.lang !== undefined ? { lang: t.meta.lang } : {}),
    ...(t.meta.label !== undefined ? { label: t.meta.label } : {}),
    ...(t.meta.width !== undefined ? { width: t.meta.width } : {}),
    ...(t.meta.height !== undefined ? { height: t.meta.height } : {}),
    ...(t.meta.framerate !== undefined ? { framerate: t.meta.framerate } : {}),
    ...(t.meta.bitrate !== undefined ? { bitrate: t.meta.bitrate } : {}),
    ...(t.meta.samplerate !== undefined ? { samplerate: t.meta.samplerate } : {}),
    ...(t.meta.channelConfig !== undefined ? { channelConfig: t.meta.channelConfig } : {}),
  });

  if (format === 'cmsf-01') {
    return buildCatalog({
      version: '1',
      initDataList: fixture.tracks.map((t) => ({
        id: initEntryId(t.meta.name), type: 'inline', data: Buffer.from(t.initData).toString('base64'),
      })),
      tracks: fixture.tracks.map((t) => ({ ...common(t), initRef: initEntryId(t.meta.name) })),
    });
  }

  return buildCatalog({
    tracks: fixture.tracks.map((t) => ({ ...common(t), initData: Buffer.from(t.initData).toString('base64') })),
  });
}

/**
 * Build an MSF-01 op-array catalog delta (§5.3) that clones the primary video
 * track into an alternate (`<name>-alt`, its own altGroup), reusing the parent's
 * init source — so it is reference-safe against the already-published catalog and
 * exercises Playa's live delta application. Returns null if there is no video
 * track to clone. The clone is a catalog-level demo: no media is published for it.
 */
export function buildFixtureDelta(fixture: LoadedFixture): Uint8Array | null {
  const video = fixture.tracks.find((t) => t.meta.role === 'video');
  if (!video) return null;
  const delta = {
    deltaUpdate: [
      { op: 'clone', tracks: [{ parentName: video.meta.name, name: `${video.meta.name}-alt`, altGroup: 9 }] },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(delta));
}

/**
 * Stop an endless loop before it reaches a group number that floating-point
 * arithmetic can no longer represent exactly — repeating a rounded group
 * would silently republish one number forever.
 */
function assertExactGroup(group: number): number {
  if (!Number.isSafeInteger(group)) {
    throw new Error(`loop reached group ${group}, beyond exact integer range — stopping`);
  }
  return group;
}

/**
 * Publish the whole fixture: catalog first, then every media track.
 *
 * `loops` (default 1) repeats the media chunks as a LIVE loop: catalog is published
 * once, each media track is PUBLISHed/accepted once, and each iteration sends the
 * track's chunks as a NEW group (groupId 0, 1, 2, …; object IDs 0..N-1 within each
 * group) — never a replay of group 0, so the relay's latest-group cache and the
 * player timeline stay sane. `Infinity` loops until killed.
 *
 * `startLoop` (default 0) is the iteration the loop BEGINS at, not an extra
 * count: the run still sends `loops` groups, numbered `startLoop …
 * startLoop + loops - 1`, with each iteration's tfdt rebased by
 * `iteration × loopSpan` as usual. A nonzero value therefore starts the whole
 * presentation at a real media origin far from zero — what a subscriber
 * joining an encoder that has been up for a while actually receives — while
 * WALL-CLOCK pacing still begins immediately, because pacing counts
 * iterations since launch rather than group numbers.
 *
 * `packaging` (default `cmaf`) selects the media Object format for every track;
 * `locmaf` sends each (rebased) CMAF chunk as one LOCMAF Object with the same
 * group/object numbering, and fails before anything is published when a track
 * has no usable CMAF Header.
 */
export async function publishFixture(
  conn: MoqtConnection,
  fixture: LoadedFixture,
  opts: { paceMs?: number; paceByMediaTime?: boolean; loops?: number; startLoop?: number; catalogFormat?: CatalogFormat; deltaAfterMs?: number; packaging?: MediaPackaging } = {},
): Promise<void> {
  const paceMs = opts.paceMs ?? 0;
  const loops = opts.loops ?? 1;
  // Rejected BEFORE the catalog is published: a bad origin would otherwise be
  // discovered as NaN group IDs partway through a live publish.
  const startLoop = opts.startLoop ?? 0;
  if (!Number.isSafeInteger(startLoop) || startLoop < 0) {
    throw new Error(`startLoop must be a nonnegative safe integer, got ${String(opts.startLoop)}`);
  }
  // `loops` is a COUNT: a positive integer, or Infinity for an endless run.
  // Checked here so the exact last-group arithmetic below has integers to
  // convert rather than something that silently becomes a BigInt error.
  if (loops !== Infinity && (!Number.isSafeInteger(loops) || loops < 1)) {
    throw new Error(`loops must be a positive safe integer or Infinity, got ${String(opts.loops)}`);
  }
  const packaging = opts.packaging ?? 'cmaf';
  const catalogFormat = opts.catalogFormat ?? (packaging === 'locmaf' ? 'cmsf-01' : 'msf-00');
  const ns = fixture.manifest.namespace;
  const deltaBytes = opts.deltaAfterMs !== undefined ? buildFixtureDelta(fixture) : null;
  if (opts.deltaAfterMs !== undefined && deltaBytes === null) {
    throw new Error('cannot emit catalog delta: fixture has no video track to clone');
  }

  // Built before anything is sent: in locmaf mode this rejects a fixture without CMAF Headers.
  const sources = fixture.tracks.map((t) => new TrackObjectSource(t, packaging));
  const timelines = opts.paceByMediaTime ? fixture.tracks.map((t) => analyzeCmafTimeline(t.initData, t.chunks)) : null;
  if (timelines?.some((t) => t === null)) throw new Error('Media-time pacing requires valid CMAF timing for every track');

  // An origin is only usable if the decode times it produces still FIT the
  // fixture's tfdt fields. Rebasing one group proves that for the whole run's
  // first group, and doing it here means an unsupported origin is refused
  // before a catalog or any media reaches the wire, rather than after a
  // subscriber has started believing a wrapped timeline.
  for (const s of sources) {
    try {
      s.cmafChunksForGroup(startLoop);
    } catch (e) {
      throw new Error(
        `startLoop ${startLoop} is not publishable for track ${s.name}: ${(e as Error).message}`,
      );
    }
  }
  // Group numbers must stay exact. A finite run's LAST group is known now; an
  // endless one is checked per iteration below, because it has no last group.
  //
  // In BigInt, because the sum is the very thing in question: evaluating
  // `startLoop + loops - 1` as a Number can ROUND back into safe range —
  // MAX_SAFE_INTEGER + 2 - 1 is MAX_SAFE_INTEGER — so testing that result
  // would ask whether the rounded answer is safe, not the real one.
  if (loops !== Infinity) {
    const lastGroup = BigInt(startLoop) + BigInt(loops) - 1n;
    if (lastGroup > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `startLoop ${startLoop} with ${loops} loops would end at group `
        + `${lastGroup}, beyond exact integer range`,
      );
    }
  }

  const catalogBytes = buildFixtureCatalog(fixture, catalogFormat, packaging);
  log(`catalog built: ${catalogBytes.byteLength} bytes, ${fixture.tracks.length} tracks (${catalogFormat}, ${packaging})`);
  await publishObjects(conn, ns, CATALOG_TRACK_NAME, 10n, [catalogBytes], 0);

  // Optional live op-array delta: after `deltaAfterMs`, publish a catalog
  // delta as a NEW group on the already-established catalog track. Fire-and-await
  // at the end for finite runs; in an endless loop it fires on its own timer.
  const deltaTask = deltaBytes
    ? (async () => {
        await sleep(opts.deltaAfterMs!);
        await sendGroup(conn, 10n, 1n, [deltaBytes], 0);
        log(`published op-array catalog delta after ${opts.deltaAfterMs}ms (catalog group 1)`);
      })()
    : null;

  if (loops === 1 && !timelines) {
    // One-shot: each track established and group 0 sent.
    let alias = 11n;
    for (const s of sources) {
      const a = alias++;
      await establishTrack(conn, ns, s.name, a);
      await sendGroup(conn, a, BigInt(startLoop), s.objectsForGroup(startLoop), paceMs, { packaging });
    }
    if (deltaTask) await deltaTask; // finite run: don't exit before the delta lands
    log('fixture fully published');
    return;
  }

  // Loop mode: establish every track ONCE, then advance group IDs together.
  // CMAF tracks get a CONTINUOUS media timeline: each iteration's chunks are
  // copies with tfdt rebased by iteration × loopSpan, so the loop presents as
  // one endless stream instead of replaying timestamps (which wedges MSE
  // players at the seam — the timeline-overlap dropper discards replays).
  let alias = 11n;
  const handles: { alias: bigint; source: TrackObjectSource }[] = [];
  for (const [index, s] of sources.entries()) {
    const a = alias++;
    await establishTrack(conn, ns, s.name, a);
    if (s.spanTicks === null) {
      log(`NOTE: ${s.name} chunks are not parseable CMAF (synthetic fixture?) — loop will replay timestamps`);
    } else {
      log(`${s.name}: loop span ${s.spanTicks} ticks — tfdt rebased per iteration`);
    }
    // The decode time a subscriber receives FIRST, read back from the bytes
    // about to be sent rather than computed from the group number — the group
    // identifies the iteration, this is the media timing that goes with it.
    const firstBmd = firstFragmentBmd(s.cmafChunksForGroup(startLoop));
    if (firstBmd !== null) {
      const timescale = timelines?.[index]?.timescale;
      log(`${s.name}: first group ${startLoop} tfdt ${firstBmd} ticks`
        + (timescale ? ` @${timescale} Hz (${(Number(firstBmd) / timescale).toFixed(3)}s)` : ''));
    }
    handles.push({ alias: a, source: s });
  }
  log(`loop mode: ${handles.length} tracks established; sending ${loops === Infinity ? 'endless' : loops} group(s)`);

  if (timelines) {
    const startMs = performance.now();
    log(`media epoch_ms=${Date.now()}`);
    await Promise.all(handles.map(async (h, index) => {
      const timeline = timelines[index]!;
      if (!timeline) throw new Error('Missing track timing');
      // `i` is iterations since launch and `g` is the media/group number.
      // Pacing must use `i`: scheduling by `g` would hold the FIRST group back
      // by startLoop × durationMs and start the stream minutes late.
      for (let i = 0; i < loops; i++) {
        const g = assertExactGroup(startLoop + i);
        await sendGroup(conn, h.alias, BigInt(g), h.source.objectsForGroup(g), 0, {
          timeline, startMs: startMs + i * timeline.durationMs,
          packaging,
        });
      }
    }));
  } else {
    for (let i = 0; i < loops; i++) {
      const g = assertExactGroup(startLoop + i);
      await Promise.all(handles.map((h) => sendGroup(conn, h.alias, BigInt(g), h.source.objectsForGroup(g), paceMs, { packaging })));
      log(`group ${g} sent on ${handles.length} track(s)`);
    }
  }
  if (deltaTask) await deltaTask; // finite loop count: ensure the delta landed
  log('loop publishing finished');
}
