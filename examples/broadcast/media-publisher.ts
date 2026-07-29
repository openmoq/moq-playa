/**
 * Media publication for the broadcast example, DOM-free so the concurrency
 * and wire contracts are unit-testable.
 *
 * WebCodecs chunk callbacks are synchronous and void — they must never be
 * given an async handler directly, because under backpressure several
 * handler invocations would interleave at their first await: two video
 * chunks could read the same object ID before either increments it, and a
 * keyframe's stream rotation could close a subgroup a delta frame is still
 * writing to. Publication is therefore an explicit BOUNDED QUEUE per media
 * type with a single-flight pump: `publish*` are synchronous enqueues, and
 * all state (object IDs, group IDs, the open subgroup) is read and written
 * only inside the pump, so IDs are unique and ordered by construction.
 *
 * Backpressure is bounded, with codec-safe overflow behavior:
 * - VIDEO: a full queue means continuity is lost — queued dependents are
 *   invalidated (dropped) and further dependents are dropped until the next
 *   keyframe opens a fresh group at Object 0.
 * - AUDIO: chunks are independently decodable (one per group), so the
 *   OLDEST queued chunk is dropped, favoring live latency.
 *
 * Wire behavior binds to the NEGOTIATED draft supplied at construction:
 * LOC extension properties use `locWireProfileForDraft(draft)` (draft-18's
 * vi64 codec diverges from the QUIC varint), and on draft-18 every subgroup
 * this original publisher opens sets the mandatory FIRST_OBJECT bit
 * (draft-18 §2.2); draft-14/16 bytes are unchanged.
 *
 * One instance is bound to ONE connection for its whole life — a broadcast
 * generation. A restart builds a fresh publisher (aliases start unset, so
 * nothing can be sent through a stale alias before the relay subscribes),
 * and `retire()` makes the old generation inert: queued work is dropped,
 * in-flight work is awaited by `drain()`, and late enqueues are ignored —
 * an old generation can never write to a replacement session.
 */
import { encodeLocHeaders, locWireProfileForDraft } from '@moqt/loc';
import type { DraftVersion } from '@moqt/transport';

/** The subset of MoqtConnection the media publication path uses. */
export interface MediaPublishConnection {
  openSubgroup(
    alias: unknown,
    groupId: unknown,
    subgroupId: unknown,
    options: Record<string, unknown>,
  ): Promise<bigint>;
  sendObject(streamId: bigint, objectId: unknown, payload: Uint8Array, extensions?: Uint8Array): Promise<void>;
  closeSubgroup(streamId: bigint): Promise<void>;
}

export interface VideoChunkMeta {
  isKeyframe: boolean;
  /** Capture timestamp in microseconds (WebCodecs chunk timestamp). */
  timestampUs: number;
  /** Codec description (decoder config) to ride as the LOC videoConfig. */
  videoConfig?: Uint8Array;
}

export interface AudioChunkMeta {
  /** Capture timestamp in microseconds (WebCodecs chunk timestamp). */
  timestampUs: number;
}

export interface MediaPublisherOptions {
  /** Wraps a bigint as the wire integer type (the example passes `varint`). */
  wrapInt: (n: bigint) => unknown;
  /** NEGOTIATED MoQT draft — selects the LOC wire profile and, on draft-18,
   *  the mandatory FIRST_OBJECT subgroup bit. Typed (not `number`) so an
   *  unsupported draft cannot silently inherit draft-16 LOC behavior. */
  draft: DraftVersion;
  /** Failure sink — publication errors are contained, never unhandled. */
  onError?: (context: string, err: unknown) => void;
  /** Counter sink for UI updates: called after each published object. */
  onCounts?: (videoFrames: number, audioChunks: number) => void;
  /** Queue bounds (frames/chunks). Defaults: video 60, audio 50. */
  videoQueueMax?: number;
  audioQueueMax?: number;
  /**
   * Maximum audio publications in flight at once (default 8). Audio chunks
   * are independent groups on independent streams, so they are published
   * CONCURRENTLY: serializing an open+send+close round trip per 20ms chunk
   * caps throughput far below the encoder's output rate. This bounds the
   * fan-out so concurrency is still backpressure, not unlimited streams.
   */
  audioMaxInFlight?: number;
}

/** Drafts whose wire behavior this publisher implements explicitly. */
const SUPPORTED_DRAFTS: readonly DraftVersion[] = [14, 16, 18];

/** Validate a queue bound: NaN/Infinity would disable backpressure entirely
 *  and a non-positive or fractional cap has no coherent meaning. */
function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}

interface QueuedVideo { data: Uint8Array; meta: VideoChunkMeta }
interface QueuedAudio { data: Uint8Array; meta: AudioChunkMeta }

export class MediaPublisher {
  private readonly connection: MediaPublishConnection;
  private readonly wrapInt: (n: bigint) => unknown;
  private readonly draft: DraftVersion;
  private readonly onError: (context: string, err: unknown) => void;
  private readonly onCounts: ((v: number, a: number) => void) | null;
  private readonly videoQueueMax: number;
  private readonly audioQueueMax: number;
  private readonly audioMaxInFlight: number;

  private videoAlias: bigint | null = null;
  private audioAlias: bigint | null = null;

  private videoGroupId: bigint;
  private videoObjectId = 0n;
  private videoStreamId: bigint | null = null;
  private audioGroupId: bigint;

  private videoFrames = 0;
  private audioChunks = 0;

  /** Explicit bounded queues + single-flight pumps (the serialization). */
  private readonly videoQueue: QueuedVideo[] = [];
  private readonly audioQueue: QueuedAudio[] = [];
  private videoPump: Promise<void> = Promise.resolve();
  private videoPumping = false;
  /** In-flight audio publications (bounded by {@link audioMaxInFlight}). */
  private readonly audioInFlight = new Set<Promise<void>>();

  /** Video continuity lost (queue overflow): dependents are invalid until
   *  the next keyframe opens a fresh group at Object 0. */
  private videoContinuityLost = false;
  private audioOverflowing = false;

  private stopped = false;

  /** Every subgroup close ever initiated — drain() waits for all of them. */
  private readonly pendingCloses = new Set<Promise<void>>();

  constructor(connection: MediaPublishConnection, options: MediaPublisherOptions) {
    // Validate before any state exists: a NaN/Infinity bound would silently
    // disable backpressure, and an unsupported draft would silently emit
    // draft-16 LOC bytes on a session that negotiated something else.
    if (!SUPPORTED_DRAFTS.includes(options.draft)) {
      throw new Error(`unsupported draft ${String(options.draft)} — supported: ${SUPPORTED_DRAFTS.join(', ')}`);
    }
    if (options.videoQueueMax !== undefined) assertPositiveInteger(options.videoQueueMax, 'videoQueueMax');
    if (options.audioQueueMax !== undefined) assertPositiveInteger(options.audioQueueMax, 'audioQueueMax');
    if (options.audioMaxInFlight !== undefined) assertPositiveInteger(options.audioMaxInFlight, 'audioMaxInFlight');
    this.connection = connection;
    this.wrapInt = options.wrapInt;
    this.draft = options.draft;
    this.onError = options.onError ?? (() => {});
    this.onCounts = options.onCounts ?? null;
    this.videoQueueMax = options.videoQueueMax ?? 60;
    this.audioQueueMax = options.audioQueueMax ?? 50;
    this.audioMaxInFlight = options.audioMaxInFlight ?? 8;
    this.videoGroupId = BigInt(Date.now());
    this.audioGroupId = BigInt(Date.now()) + 1_000_000n; // offset to avoid collision
  }

  /** Bind the relay-subscribed aliases (from the accepted SUBSCRIBEs). */
  setVideoAlias(alias: bigint): void { this.videoAlias = alias; }
  setAudioAlias(alias: bigint): void { this.audioAlias = alias; }

  get frameCount(): number { return this.videoFrames; }
  get audioChunkCount(): number { return this.audioChunks; }

  /**
   * Enqueue one encoded video chunk. Synchronous and void — safe to call
   * from a WebCodecs output callback. Dropped if the publisher is stopped
   * or the video alias is not yet bound (never a stale-alias send).
   */
  publishVideo(data: Uint8Array, meta: VideoChunkMeta): void {
    if (this.stopped || this.videoAlias === null) return;
    if (this.videoQueue.length >= this.videoQueueMax) {
      // Overflow: the queued dependents can never all be delivered in time —
      // continuity is lost. Invalidate the whole backlog and recover at the
      // next keyframe (fresh group, Object 0). Report once per episode.
      this.videoQueue.length = 0;
      if (!this.videoContinuityLost) {
        this.videoContinuityLost = true;
        this.report('video publish', new Error(
          `video queue overflow (${this.videoQueueMax} frames): dropping until the next keyframe`));
      }
    }
    if (this.videoContinuityLost) {
      if (!meta.isKeyframe) return; // dependents are invalid without their base
      this.videoContinuityLost = false;
    }
    this.videoQueue.push({ data, meta });
    this.pumpVideo();
  }

  /** Enqueue one encoded audio chunk (same contract as {@link publishVideo}). */
  publishAudio(data: Uint8Array, meta: AudioChunkMeta): void {
    if (this.stopped || this.audioAlias === null) return;
    if (this.audioQueue.length >= this.audioQueueMax) {
      // Audio chunks are independently decodable — drop the OLDEST to keep
      // the live edge. Report once per overflow episode.
      this.audioQueue.shift();
      if (!this.audioOverflowing) {
        this.audioOverflowing = true;
        this.report('audio publish', new Error(
          `audio queue overflow (${this.audioQueueMax} chunks): dropping oldest`));
      }
    }
    this.audioQueue.push({ data, meta });
    this.pumpAudio();
  }

  /**
   * Synchronously retire this broadcast generation: further enqueues are
   * ignored and all queued work is dropped. Retirement never blocks — the
   * caller drives the graceful-drain / hard-close sequence (see
   * BroadcastSession.shutdown) and then awaits {@link drain}.
   */
  retire(): void {
    this.stopped = true;
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
  }

  /**
   * Await everything this generation started: both pumps and every tracked
   * subgroup close, then close (FIN) the open video subgroup. After
   * resolution, no publication from this generation can reach the
   * connection. Never rejects (all failures are contained best-effort).
   */
  async drain(): Promise<void> {
    await this.videoPump;
    while (this.audioInFlight.size > 0) {
      await Promise.all([...this.audioInFlight]);
    }
    while (this.pendingCloses.size > 0) {
      await Promise.all([...this.pendingCloses]);
    }
    if (this.videoStreamId !== null) {
      const sid = this.videoStreamId;
      this.videoStreamId = null;
      try { await this.connection.closeSubgroup(sid); } catch { /* already closed */ }
    }
  }

  /** Convenience for callers with no stalled-send hazard: retire + drain. */
  async stop(): Promise<void> {
    this.retire();
    await this.drain();
  }

  /** The error sink is application code — a throw from it must not reject
   *  or poison a publication pump, nor make drain()/stop() reject. */
  private report(context: string, err: unknown): void {
    try {
      this.onError(context, err);
    } catch { /* contained: the sink cannot poison the chain */ }
  }

  /** Initiate a subgroup close and TRACK it — drain() awaits every close,
   *  so none is fire-and-forget. Close failures are best-effort. */
  private trackClose(streamId: bigint): Promise<void> {
    const close = this.connection.closeSubgroup(streamId).then(() => {}, () => {});
    this.pendingCloses.add(close);
    void close.then(() => this.pendingCloses.delete(close));
    return close;
  }

  /** draft-18 §2.2: the original publisher MUST set FIRST_OBJECT on every
   *  new subgroup. The option is d18-only (the adapter rejects it on 14/16). */
  private subgroupOptions(priority: number): Record<string, unknown> {
    return {
      hasExtensions: true,
      endOfGroup: true,
      publisherPriority: priority,
      ...(this.draft === 18 ? { firstObject: true } : {}),
    };
  }

  // ─── Single-flight pumps (only ever one in flight per media type) ────

  private pumpVideo(): void {
    if (this.videoPumping) return;
    this.videoPumping = true;
    this.videoPump = (async () => {
      try {
        while (this.videoQueue.length > 0 && !this.stopped) {
          const item = this.videoQueue.shift()!;
          try {
            await this.sendVideoChunk(item.data, item.meta);
          } catch (err) {
            this.report('video publish', err);
          }
        }
      } finally {
        this.videoPumping = false;
      }
    })();
  }

  /**
   * Dispatch queued audio up to the in-flight cap. Group IDs are allocated
   * synchronously here, so concurrent publications still carry unique,
   * monotonic group IDs.
   */
  private pumpAudio(): void {
    while (this.audioQueue.length > 0 && !this.stopped && this.audioInFlight.size < this.audioMaxInFlight) {
      const item = this.audioQueue.shift()!;
      const groupId = ++this.audioGroupId;
      const inFlight = (async () => {
        try {
          await this.sendAudioChunk(item.data, item.meta, groupId);
        } catch (err) {
          this.report('audio publish', err);
        }
      })();
      this.audioInFlight.add(inFlight);
      void inFlight.then(() => {
        this.audioInFlight.delete(inFlight);
        // A freed slot may admit the next queued chunk.
        if (!this.stopped) this.pumpAudio();
      });
    }
  }

  private videoExtensions(meta: VideoChunkMeta): Uint8Array | undefined {
    return encodeLocHeaders({
      captureTimestamp: BigInt(Math.round(meta.timestampUs)),
      videoFrameMarking: {
        independent: meta.isKeyframe,
        discardable: !meta.isKeyframe,
        baseLayerSync: false,
        startOfFrame: true,
        endOfFrame: true,
        temporalId: 0,
      },
      ...(meta.videoConfig ? { videoConfig: meta.videoConfig } : {}),
    }, { wireProfile: locWireProfileForDraft(this.draft) });
  }

  private async sendVideoChunk(data: Uint8Array, meta: VideoChunkMeta): Promise<void> {
    if (meta.isKeyframe) {
      // New group per keyframe. The previous subgroup has no further writers
      // (the pump is the only one), so its close needs no await — but it
      // IS tracked, so drain() waits for it. The slot is cleared BEFORE the
      // new open: a failed open must leave NO stream, not revive the old one.
      if (this.videoStreamId !== null) {
        const oldStreamId = this.videoStreamId;
        this.videoStreamId = null;
        this.trackClose(oldStreamId);
      }
      this.videoGroupId++;
      this.videoObjectId = 0n;
      // endOfGroup: true — required for one-subgroup-per-GOP LOC video.
      // Without this, receivers cannot distinguish normal group completion
      // from an incomplete group and will wait for the intra-group timeout.
      this.videoStreamId = await this.connection.openSubgroup(
        this.wrapInt(this.videoAlias!), this.wrapInt(this.videoGroupId), this.wrapInt(0n),
        this.subgroupOptions(128),
      );
    }
    // No open subgroup — either pre-first-keyframe, or the group was retired
    // by a failure. Dependent frames are dropped until the next keyframe.
    if (this.videoStreamId === null) return;

    try {
      await this.connection.sendObject(
        this.videoStreamId, this.wrapInt(this.videoObjectId), data, this.videoExtensions(meta));
    } catch (err) {
      // LOC: Object 0 of a subgroup must be the independent frame. After a
      // failed (or ambiguous) send the group is unusable — retire it, so
      // deltas drop until the next keyframe opens a fresh group at Object 0.
      const broken = this.videoStreamId;
      this.videoStreamId = null;
      this.trackClose(broken);
      throw err;
    }
    this.videoObjectId++;
    this.videoFrames++;
    this.onCounts?.(this.videoFrames, this.audioChunks);
  }

  private async sendAudioChunk(data: Uint8Array, meta: AudioChunkMeta, groupId: bigint): Promise<void> {
    const extensions = encodeLocHeaders({
      captureTimestamp: BigInt(Math.round(meta.timestampUs)),
    }, { wireProfile: locWireProfileForDraft(this.draft) });
    // Audio: one object per group (independently decodable, LOC §4.1);
    // audio gets higher priority (lower value) than video.
    const streamId = await this.connection.openSubgroup(
      this.wrapInt(this.audioAlias!), this.wrapInt(groupId), this.wrapInt(0n),
      this.subgroupOptions(64),
    );
    try {
      await this.connection.sendObject(streamId, this.wrapInt(0n), data, extensions);
    } catch (err) {
      this.trackClose(streamId); // best-effort terminal cleanup for the failed stream
      throw err;
    }
    await this.trackClose(streamId);
    this.audioChunks++;
    this.onCounts?.(this.videoFrames, this.audioChunks);
    if (this.audioQueue.length < this.audioQueueMax) this.audioOverflowing = false;
  }
}
