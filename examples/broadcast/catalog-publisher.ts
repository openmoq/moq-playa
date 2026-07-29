/**
 * Catalog publication for the broadcast example, DOM-free so the subscription
 * lifecycle is unit-testable.
 *
 * The catalog subscription is accepted and the catalog object is sent, and the
 * subscription then REMAINS ESTABLISHED on success.
 *
 * PUBLISH_DONE(TRACK_ENDED) terminates that subscription and states the track
 * is no longer being published; it does not by itself mean the broadcast
 * ended. We deliberately do NOT send it at startup for two practical reasons:
 * a live catalog track must stay available for catalog delta updates, and
 * relays reasonably treat an ended upstream track as final — one was observed
 * leaving later viewers' catalog SUBSCRIBEs unanswered afterwards. Sending it
 * would be legal but would foreclose both.
 *
 * The catalog advertises only tracks the capture can actually publish: audio
 * is included only when {@link BroadcastCatalogParams.audio} is present (a
 * screen capture without audio must not advertise an audio track).
 */
import { varint, SubgroupIdMode, PublishDoneCode } from '@moqt/transport';
import type { DraftVersion } from '@moqt/transport';
import { buildCatalog } from '@moqt/msf';

/** Bound on EACH step of an error-response transaction (the best-effort stream
 *  close and the terminal/rejection write). A write that never settles must not
 *  strand the subscriber — the session close is the fallback. */
const DEFAULT_TERMINAL_CLOSE_DEADLINE_MS = 500;

/** Validate a caller-supplied deadline before any wire effect. */
function assertPositiveIntegerMs(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds, got ${value}`);
  }
}

/**
 * Await `op`, propagating ITS failure, but reject with a timeout error if it
 * does not settle within `ms`. Used where the operation is part of the success
 * criterion (the catalog FIN) and the caller must distinguish neither-yet.
 */
async function awaitWithin(op: Promise<void>, ms: number, what: string): Promise<void> {
  // An abandoned op must not surface later as an unhandled rejection; the race
  // below still observes the original rejection for error identity.
  void op.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      op,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Await `op` but never longer than `ms`. Resolves true if it settled inside the
 * window (successfully), false if it failed OR timed out — the caller treats
 * both as "this response did not reach the peer".
 */
async function settledWithin(op: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ok = await Promise.race([
    op.then(() => true, () => false),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return ok;
}

/** The subset of MoqtConnection the catalog publication path uses. */
export interface CatalogPublishConnection {
  acceptSubscribe(requestId: ReturnType<typeof varint>, alias: ReturnType<typeof varint>): Promise<void>;
  openSubgroup(
    alias: ReturnType<typeof varint>,
    groupId: ReturnType<typeof varint>,
    subgroupId: ReturnType<typeof varint>,
    options: Record<string, unknown>,
  ): Promise<bigint>;
  sendObject(streamId: bigint, objectId: ReturnType<typeof varint>, payload: Uint8Array): Promise<void>;
  closeSubgroup(streamId: bigint): Promise<void>;
  /** Answer a request we cannot serve at all (nothing was accepted). */
  rejectSubscribe(requestId: ReturnType<typeof varint>, errorCode: ReturnType<typeof varint>, reason: string): Promise<void>;
  /** Terminal for a subscription we accepted but cannot serve. */
  publishDone(requestId: ReturnType<typeof varint>, statusCode: unknown, reason: string): Promise<void>;
  /** Last resort when the terminal itself cannot be sent. */
  close(): Promise<void>;
}

export interface BroadcastCatalogParams {
  videoCodec: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  /** Present only when the capture HAS audio — a catalog must not advertise
   *  a track that can never publish. */
  audio?: {
    sampleRate: number;
    channels: number;
  };
}

/**
 * Accept the relay's catalog SUBSCRIBE and publish the catalog object.
 *
 * Publishes with a timestamp-based group ID (matches mojito pattern); wire
 * format matches mojito: SubgroupIDZero, DefaultPriority, EndOfGroup. The
 * data stream is always closed — success or failure — while the
 * SUBSCRIPTION stays live (no terminal is sent; see module doc). On
 * draft-18 the subgroup carries the mandatory FIRST_OBJECT bit (§2.2);
 * draft-14/16 bytes are unchanged.
 *
 * @returns the catalog payload size in bytes (for logging).
 */
export async function acceptCatalogSubscribe(
  connection: CatalogPublishConnection,
  requestId: bigint,
  alias: bigint,
  params: BroadcastCatalogParams,
  wire: { draft: DraftVersion; terminalCloseDeadlineMs?: number },
): Promise<number> {
  // Build BEFORE accepting: a build failure must never leave a subscription
  // ESTABLISHED with nothing to send it. The request is still ANSWERED —
  // an unanswered SUBSCRIBE strands the subscriber forever.
  const deadlineMs = wire.terminalCloseDeadlineMs ?? DEFAULT_TERMINAL_CLOSE_DEADLINE_MS;
  if (wire.terminalCloseDeadlineMs !== undefined) {
    assertPositiveIntegerMs(wire.terminalCloseDeadlineMs, 'terminalCloseDeadlineMs');
  }

  let catalogPayload: Uint8Array;
  try {
    catalogPayload = buildCatalogPayload(params);
  } catch (err) {
    await rejectUnservable(connection, requestId, err, deadlineMs);
    throw err;
  }
  // Past this point the subscription is ESTABLISHED: every failure path must
  // reach an explicit terminal outcome. Leaving it established with neither a
  // catalog nor a terminal would strand the subscriber forever.
  await connection.acceptSubscribe(varint(requestId), varint(alias));

  const catalogGroupId = varint(BigInt(Date.now()));
  let streamId: bigint | null = null;
  try {
    streamId = await connection.openSubgroup(
      varint(alias), catalogGroupId, varint(0),
      {
        hasExtensions: false,
        endOfGroup: true,
        defaultPriority: true,
        subgroupIdMode: SubgroupIdMode.ZERO,
        ...(wire.draft === 18 ? { firstObject: true } : {}),
      },
    );
    await connection.sendObject(streamId, varint(0), catalogPayload);
    // The clean FIN is part of SUCCESS, not cleanup: without it the receiver
    // cannot tell the catalog group ended, so a FIN failure is a failure — and
    // it is BOUNDED, because a FIN that never settles would otherwise hang
    // startup forever and never reach the terminal path below.
    await awaitWithin(connection.closeSubgroup(streamId), deadlineMs, 'catalog FIN');
    streamId = null;
  } catch (err) {
    await terminateFailedCatalog(connection, requestId, streamId, err, deadlineMs);
    throw err;
  }

  return catalogPayload.byteLength;
}

/**
 * Explicit terminal for a catalog subscription we accepted but could not
 * serve: close any open data stream, then PUBLISH_DONE(INTERNAL_ERROR). If
 * the terminal itself cannot be sent, close the SESSION — an established
 * subscription we can neither serve nor terminate is worse than a lost
 * session, because the subscriber would wait forever.
 */
async function terminateFailedCatalog(
  connection: CatalogPublishConnection,
  requestId: bigint,
  openStreamId: bigint | null,
  cause: unknown,
  closeDeadlineMs = DEFAULT_TERMINAL_CLOSE_DEADLINE_MS,
): Promise<void> {
  if (openStreamId !== null) {
    // BOUNDED best-effort: the terminal below is what un-strands the
    // subscriber, so a stuck stream close must not delay it indefinitely.
    await settledWithin(connection.closeSubgroup(openStreamId), closeDeadlineMs);
  }
  const reason = `catalog publication failed: ${(cause as Error)?.message ?? String(cause)}`;
  // The terminal write is bounded too: a publishDone that never settles would
  // otherwise leave the accepted subscription silent forever AND prevent the
  // session-close fallback from ever running.
  const terminated = await settledWithin(
    connection.publishDone(varint(requestId), PublishDoneCode.INTERNAL_ERROR, reason),
    closeDeadlineMs,
  );
  if (!terminated) {
    await settledWithin(connection.close(), closeDeadlineMs);
  }
}

/** Assemble the catalog payload. Pure: no wire effects, so a failure here is
 *  safely recoverable by answering the request with a rejection. */
function buildCatalogPayload(params: BroadcastCatalogParams): Uint8Array {
  return buildCatalog({
    tracks: [
      {
        name: 'video',
        packaging: 'loc',
        isLive: true,
        role: 'video',
        codec: params.videoCodec,
        width: params.width,
        height: params.height,
        framerate: params.fps,
        bitrate: params.videoBitrate,
        renderGroup: 1,
      },
      ...(params.audio ? [{
        name: 'audio',
        packaging: 'loc' as const,
        isLive: true as const,
        role: 'audio' as const,
        codec: 'opus',
        samplerate: params.audio.sampleRate,
        channelConfig: String(params.audio.channels),
        bitrate: 128_000,
        renderGroup: 1,
      }] : []),
    ],
  });
}

/** Answer a request we never accepted. If even the rejection cannot be sent,
 *  close the session — a silent request is the worse failure. */
async function rejectUnservable(
  connection: CatalogPublishConnection,
  requestId: bigint,
  cause: unknown,
  deadlineMs = DEFAULT_TERMINAL_CLOSE_DEADLINE_MS,
): Promise<void> {
  const reason = `catalog unavailable: ${(cause as Error)?.message ?? String(cause)}`;
  // Bounded: a rejection that never settles leaves the request as silent as
  // sending nothing, so fall through to closing the session.
  const rejected = await settledWithin(
    connection.rejectSubscribe(varint(requestId), varint(0x0), reason),
    deadlineMs,
  );
  if (!rejected) {
    await settledWithin(connection.close(), deadlineMs);
  }
}
