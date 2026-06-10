/**
 * Publish a LoadedFixture into the relay over MoQT draft-18, using public APIs only:
 *
 *   1. catalog track first — `buildCatalog()` with each track's metadata and base64
 *      initData; one object (group 0, object 0).
 *   2. each media track — one PUBLISH, then group 0 as a single subgroup with one
 *      object per chunk (objectId 0..N-1, `firstObject: true` on open). This is the
 *      same group/object scheme the future real-fixture path will use (group =
 *      fragment sequence; the 2s fixture is one group).
 *
 * Pacing: `paceMs > 0` sleeps between chunks (timestamp-style pacing for a live
 * demo); the smoke uses 0 (as fast as possible).
 */
import { buildCatalog, CATALOG_TRACK_NAME } from '@moqt/msf';
import type { MoqtConnection } from '@moqt/webtransport';
import type { LoadedFixture, LoadedTrack } from './fixture.js';

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
async function establishTrack(
  conn: MoqtConnection,
  namespace: readonly string[],
  track: string,
  alias: bigint,
): Promise<void> {
  const ns = namespace.map((p) => te.encode(p));
  const requestId = await conn.publish(ns, te.encode(track), alias);
  await waitForPublishAccept(conn, requestId);
}

/**
 * Send `objects` as ONE group on an established track: a single subgroup
 * (groupId, subgroup 0) carrying objects 0..N-1, then FIN. `firstObject` is set on
 * the open because object 0 genuinely is the first object ever published in THIS
 * subgroup — FIRST_OBJECT is per-subgroup (§11.4.2), and every (group, subgroup 0)
 * here is a fresh subgroup, including each loop iteration's new group.
 */
async function sendGroup(
  conn: MoqtConnection,
  alias: bigint,
  groupId: bigint,
  objects: readonly Uint8Array[],
  paceMs: number,
): Promise<void> {
  const sid = await conn.openSubgroup(alias, groupId, 0n, { publisherPriority: 128, firstObject: true });
  for (let i = 0; i < objects.length; i++) {
    await conn.sendObject(sid, BigInt(i), objects[i]!);
    if (paceMs > 0 && i < objects.length - 1) await sleep(paceMs);
  }
  await conn.closeSubgroup(sid);
}

/** PUBLISH one track and send `objects` as group 0 / objects 0..N-1 (one-shot). */
async function publishObjects(
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

/** Map fixture metadata → MSF catalog bytes (init segments ride as base64 initData). */
export function buildFixtureCatalog(fixture: LoadedFixture): Uint8Array {
  return buildCatalog({
    tracks: fixture.tracks.map((t: LoadedTrack) => ({
      name: t.meta.name,
      packaging: t.meta.packaging,
      isLive: true,
      role: t.meta.role,
      codec: t.meta.codec,
      renderGroup: fixture.manifest.renderGroup,
      initData: Buffer.from(t.initData).toString('base64'),
      ...(t.meta.width !== undefined ? { width: t.meta.width } : {}),
      ...(t.meta.height !== undefined ? { height: t.meta.height } : {}),
      ...(t.meta.framerate !== undefined ? { framerate: t.meta.framerate } : {}),
      ...(t.meta.bitrate !== undefined ? { bitrate: t.meta.bitrate } : {}),
      ...(t.meta.samplerate !== undefined ? { samplerate: t.meta.samplerate } : {}),
      ...(t.meta.channelConfig !== undefined ? { channelConfig: t.meta.channelConfig } : {}),
    })),
  });
}

/**
 * Publish the whole fixture: catalog first, then every media track.
 *
 * `loops` (default 1) repeats the media chunks as a LIVE loop: catalog is published
 * once, each media track is PUBLISHed/accepted once, and each iteration sends the
 * track's chunks as a NEW group (groupId 0, 1, 2, …; object IDs 0..N-1 within each
 * group) — never a replay of group 0, so the relay's latest-group cache and the
 * player timeline stay sane. `Infinity` loops until killed.
 */
export async function publishFixture(
  conn: MoqtConnection,
  fixture: LoadedFixture,
  opts: { paceMs?: number; loops?: number } = {},
): Promise<void> {
  const paceMs = opts.paceMs ?? 0;
  const loops = opts.loops ?? 1;
  const ns = fixture.manifest.namespace;

  const catalogBytes = buildFixtureCatalog(fixture);
  log(`catalog built: ${catalogBytes.byteLength} bytes, ${fixture.tracks.length} tracks`);
  await publishObjects(conn, ns, CATALOG_TRACK_NAME, 10n, [catalogBytes], 0);

  if (loops === 1) {
    // One-shot (unchanged behavior): each track established + group 0 sent.
    let alias = 11n;
    for (const t of fixture.tracks) {
      await publishObjects(conn, ns, t.meta.name, alias++, t.chunks, paceMs);
    }
    log('fixture fully published');
    return;
  }

  // Loop mode: establish every track ONCE, then advance group IDs together.
  let alias = 11n;
  const handles: { track: string; alias: bigint; chunks: readonly Uint8Array[] }[] = [];
  for (const t of fixture.tracks) {
    const a = alias++;
    await establishTrack(conn, ns, t.meta.name, a);
    handles.push({ track: t.meta.name, alias: a, chunks: t.chunks });
  }
  log(`loop mode: ${handles.length} tracks established; sending ${loops === Infinity ? 'endless' : loops} group(s)`);

  for (let g = 0; g < loops; g++) {
    // Tracks send each group concurrently so one loop iteration ≈ one group duration.
    await Promise.all(handles.map((h) => sendGroup(conn, h.alias, BigInt(g), h.chunks, paceMs)));
    log(`group ${g} sent on ${handles.length} track(s)`);
  }
  log('loop publishing finished');
}
