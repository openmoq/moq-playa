/**
 * Source-paced ABR simulation.
 *
 * A live publisher cannot send media faster than it is captured: each frame
 * leaves the relay when it exists, so a receiver with spare capacity sees the
 * link sit idle between frames. Any estimator that divides bytes by
 * wall-clock arrival spacing therefore measures the ENCODING rate, not the
 * capacity — the problem low-latency DASH met with chunked CMAF.
 *
 * These scenarios drive the real `MoqtPlayer` ABR loop with that delivery
 * shape. A mock relay serves each subscription from its start group,
 * frame-by-frame at capture pace, through a single work-conserving
 * bottleneck of fixed capacity; past frames (an AbsoluteStart behind the
 * live edge) leave at link rate, as from a relay cache.
 *
 * Boundary: transport, decoder, renderer and MSE are fakes; CMAF assembly is real on one simulated
 * clock. Every rendered-frame callback is synthesized on arrival, and the MSE
 * buffer depth is scripted — the suite tests the ABR DECISION, not playout.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { MoqtPlayer } from './player.js';
import type { PlayerError } from './errors.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { ControlMessage, MoqtObject } from '@openmoq/transport';
import { varint, ObjectStatus } from '@openmoq/transport';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, videoInit } from '../../locmaf/test-support/cmaf.js';

// ─── Media and link model ────────────────────────────────────────────

const FPS = 30;
const FRAME_US = 33_333;
const GOP_FRAMES = 60; // ≈2s groups — the player's default GOP assumption
const KEYFRAME_SHARE = 0.2;
const TICK_US = 16_667;
const PATH_DELAY_US = 20_000;
/** Publisher wall clock at simulation time 0: LOC capture timestamps are epoch µs. */
const PUBLISHER_EPOCH_US = 1_762_000_000_000_000;
/** CMAF media timeline: `videoInit()` declares 90 kHz; the origin is arbitrary. */
const CMAF_TIMESCALE = 90_000;
const CMAF_ORIGIN_TICKS = 123_456_789n;
const CMAF_FRAME_TICKS = CMAF_TIMESCALE / FPS;

interface Rung { readonly name: string; readonly bitrateBps: number }

const LADDER: readonly Rung[] = [
  { name: 'v6000', bitrateBps: 6_000_000 },
  { name: 'v3000', bitrateBps: 3_000_000 },
  { name: 'v1500', bitrateBps: 1_500_000 },
  { name: 'v800', bitrateBps: 800_000 },
  { name: 'v400', bitrateBps: 400_000 },
];

function frameBytes(bitrateBps: number, frameIndex: number): number {
  const gopBytes = bitrateBps * (GOP_FRAMES / FPS) / 8;
  return Math.round(frameIndex % GOP_FRAMES === 0
    ? gopBytes * KEYFRAME_SHARE
    : gopBytes * (1 - KEYFRAME_SHARE) / (GOP_FRAMES - 1));
}

function catalogJson(packaging: 'loc' | 'cmaf', cmafHeader: 'real' | 'opaque' = 'real'): string {
  return JSON.stringify({
    version: 1,
    tracks: LADDER.map((r, i) => ({
      name: r.name, packaging, isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
      codec: 'avc1.64001f', width: 320 * (5 - i), height: 180 * (5 - i), bitrate: r.bitrateBps,
      ...(packaging === 'cmaf'
        ? { initData: cmafHeader === 'real' ? Buffer.from(videoInit()).toString('base64') : 'AAAA' }
        : {}),
    })),
  });
}

interface Subscription {
  readonly requestId: bigint;
  readonly alias: bigint;
  readonly trackName: string;
  /** First group served; resolved from the filter against the live edge. */
  readonly startGroup: bigint;
  /** Next frame index to release. */
  nextFrame: number;
  acked: boolean;
  readonly ackAtUs: number;
  /** Largest Object when the subscription was made: its Joining Location. */
  readonly joiningFrame: number;
  active: boolean;
  /** Forward state 0: the relay holds this subscription's objects back. */
  paused: boolean;
  /** Subscriber priority: a lower value is sent first. */
  priority: number;
}

type Queued = Omit<InFlight, 'arrivalUs'>;

interface InFlight {
  readonly sub: Subscription;
  readonly frameIndex: number;
  readonly bytes: number;
  /** When the frame may leave the relay. */
  readonly releaseUs: number;
  readonly arrivalUs: number;
  /** Set for a frame served by a FETCH rather than the subscription. */
  readonly fetch?: JoiningFetch;
}

/** An Absolute Joining FETCH being served from the relay's cache. */
interface JoiningFetch {
  readonly requestId: bigint;
  readonly streamId: bigint;
  readonly sub: Subscription;
  /** Next frame index to release, and the last one (the Joining Location). */
  nextFrame: number;
  readonly lastFrame: number;
  readonly releaseAtUs: number;
  readonly priority: number;
  started: boolean;
  /** Draft 22: a fill on the SUBSCRIBE rather than a FETCH of its own. */
  readonly fill?: boolean;
}

/**
 * Mock relay + bottleneck link. Serves every active subscription from its
 * start group at capture pace, serialised through one server that sends by
 * subscriber priority, then release order.
 */
class SourcePacedRelay {
  nowUs = 0;
  private nextRequestId = 0n;
  private allocateRequestId(): bigint { const id = this.nextRequestId; this.nextRequestId += 2n; return id; }
  private serverFreeUs = 0;
  readonly subs = new Map<bigint, Subscription>();
  /** Frames released by the relay and waiting for the bottleneck link. */
  private readonly queued: Queued[] = [];
  private readonly inFlight: InFlight[] = [];
  readonly adapter: Pick<MoqtConnection, 'onMessage' | 'onObject' | 'onDataStream' | 'onStreamClosed' | 'onClose'>;
  /** Bytes the link carried — the ground truth an estimator should approach. */
  carriedBits = 0;
  /** Every SUBSCRIBE the player sent, in order. */
  readonly subscribes: { atUs: number; requestId: bigint; trackName: string; options: any }[] = [];
  /** Every REQUEST_UPDATE the player sent, in order. */
  readonly updates: { atUs: number; requestId: bigint; options: any }[] = [];
  /** Once set, the session is gone: requests fail as on a closed session. */
  closed = false;
  /** Requests attempted after the session closed. */
  rejectedAfterClose = 0;
  /** Every Joining FETCH the player sent, in order. */
  readonly joiningFetches: { atUs: number; requestId: bigint; options: any }[] = [];
  /** Draft 22: every fill served on a SUBSCRIBE. */
  readonly fills: { atUs: number; requestId: bigint; startGroup: bigint }[] = [];
  congestedUntilUs = Infinity;
  private readonly fetches: JoiningFetch[] = [];
  private readonly cancelledFetches = new Set<bigint>();

  constructor(
    private readonly capacityBps: number,
    private readonly catalog: string,
    private readonly packaging: 'loc' | 'cmaf',
    /** Actual bytes as a fraction of the catalog bitrate (VBR undershoot). */
    private readonly contentScale = 1,
    /** Whether LOC frames carry a capture timestamp. */
    private readonly captureTimestamps = true,
    /** Whether the relay schedules by subscriber priority, or sends in release order. */
    private readonly honoursPriority = true,
    /** How the relay answers a Joining FETCH: serve it, refuse it, or accept it and never send. */
    private readonly joiningFetchMode: 'serve' | 'refuse' | 'stall' = 'serve',
    /** Draft 22: the past comes as a fill on the SUBSCRIBE (§3.4), and there is no Joining FETCH. */
    private readonly draft: 14 | 16 | 18 | 22 = 16,
  ) {
    const relay = this;
    // The mock implements only the player-facing surface; expose typed delivery callbacks here.
    this.adapter = {
      draftVersion: draft,
      session: { state: 'established', subscribe: vi.fn(() => ({ requestId: varint(1), actions: [] })), close: vi.fn(() => []) },
      onMessage: null, onClose: null, onError: null, onDataStream: null, onObject: null,
      onStreamClosed: null, onDatagram: null, onNamespaceMessage: null, onQlogEvent: null,
      connect: vi.fn(async () => {}),
      subscribe: vi.fn(async (_ns: Uint8Array[], name: Uint8Array, opts?: any) => {
        if (relay.closed) { relay.rejectedAfterClose++; throw new Error('Cannot subscribe in state closed; session must be ESTABLISHED'); }
        const requestId = relay.allocateRequestId();
        relay.subscribes.push({ atUs: relay.nowUs, requestId, trackName: new TextDecoder().decode(name), options: opts });
        opts?.onRequestId?.(requestId);
        relay.addSubscription(requestId, new TextDecoder().decode(name), opts?.subscriptionFilter, opts?.subscriberPriority);
        const fillStart = opts?.fill?.filter?.type === 'AbsoluteStart' ? Number(opts.fill.filter.startGroup) * GOP_FRAMES : undefined;
        const sub = relay.subs.get(requestId)!;
        if ((relay.draft === 22) && fillStart !== undefined && fillStart <= sub.joiningFrame) {
          // The fill stream bears the SUBSCRIBE's Request ID.
          relay.fills.push({ atUs: relay.nowUs, requestId, startGroup: BigInt(opts.fill.filter.startGroup) });
          relay.fetches.push({
            requestId, streamId: requestId * 1_000_000n + 999_999n, sub, nextFrame: fillStart, lastFrame: sub.joiningFrame,
            releaseAtUs: relay.nowUs + 2 * PATH_DELAY_US, priority: Number(opts.fill.subscriberPriority ?? sub.priority), started: false, fill: true,
          });
        }
        return varint(requestId);
      }),
      requestUpdate: vi.fn(async (id: bigint, opts?: any) => {
        if (relay.closed) { relay.rejectedAfterClose++; throw new Error('Cannot update in state closed; session must be ESTABLISHED'); }
        relay.updates.push({ atUs: relay.nowUs, requestId: BigInt(id), options: opts });
        const sub = relay.subs.get(BigInt(id));
        if (sub !== undefined && opts?.subscriberPriority !== undefined) sub.priority = Number(opts.subscriberPriority);
        if (sub !== undefined && opts?.forward !== undefined) {
          const forward = Number(opts.forward);
          // Resuming a live track starts at the next group; what was held back is skipped.
          if (sub.paused && forward === 1) sub.nextFrame = Math.max(sub.nextFrame, Number(relay.liveGroup() + 1n) * GOP_FRAMES);
          sub.paused = forward === 0;
        }
        return varint(relay.allocateRequestId());
      }),
      unsubscribe: vi.fn(async (id: bigint) => {
        const sub = relay.subs.get(BigInt(id));
        if (sub) sub.active = false;
      }),
      fetch: vi.fn(async () => varint(relay.allocateRequestId())),
      // Absolute Joining FETCH (draft-18 §10.12.2): the subscription's groups
      // from Joining Start up to its Joining Location, served from cache.
      joiningFetch: vi.fn(async (opts: any) => {
        if (relay.closed) { relay.rejectedAfterClose++; throw new Error('Cannot fetch in state closed; session must be ESTABLISHED'); }
        const requestId = relay.allocateRequestId();
        opts?.onRequestId?.(requestId);
        relay.joiningFetches.push({ atUs: relay.nowUs, requestId, options: opts });
        const sub = relay.subs.get(BigInt(opts.joiningRequestId));
        const first = Number(opts.joiningStart) * GOP_FRAMES;
        if ((relay.draft === 22)) throw new Error('draft-22 has no Joining FETCH');
        if (relay.joiningFetchMode === 'refuse') throw new Error('REQUEST_ERROR NOT_SUPPORTED');
        if (relay.joiningFetchMode === 'stall') return varint(requestId);
        if (!sub || opts.joiningFetchType !== 'absolute' || first > sub.joiningFrame) {
          throw new Error('REQUEST_ERROR INVALID_RANGE: joining start past the Joining Location');
        }
        relay.fetches.push({
          requestId, streamId: requestId * 1_000_000n + 999_999n, sub, nextFrame: first, lastFrame: sub.joiningFrame,
          releaseAtUs: relay.nowUs + 2 * PATH_DELAY_US, priority: Number(opts.subscriberPriority ?? 128), started: false,
        });
        return varint(requestId);
      }),
      fetchCancel: vi.fn(async (id: bigint) => { relay.cancelledFetches.add(BigInt(id)); }),
      cancelFill: vi.fn(async (id: bigint) => { relay.cancelledFetches.add(BigInt(id)); }),
      trackStatus: vi.fn(async (_ns: unknown, _n: unknown, opts?: { onRequestId?: (id: bigint) => void }) => {
        const id = relay.allocateRequestId();
        opts?.onRequestId?.(id);
        return varint(id);
      }),
      subscribeNamespace: vi.fn(async () => varint(relay.allocateRequestId())),
      cancelNamespace: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as SourcePacedRelay['adapter'];
  }

  liveGroup(): bigint {
    return BigInt(Math.floor(this.nowUs / FRAME_US / GOP_FRAMES));
  }

  private addSubscription(requestId: bigint, trackName: string, filter: any, subscriberPriority?: unknown): void {
    // The catalog subscription is answered with the catalog object, not media.
    // A SUBSCRIBE only delivers newly published objects (draft-18 §10.7): its
    // filter may name a start in the past, but nothing before the Largest
    // Object is sent. The past comes by FETCH.
    const largestFrame = Math.floor(this.nowUs / FRAME_US);
    const nextGroupStart = Number(this.liveGroup() + 1n) * GOP_FRAMES;
    const nextFrame = filter?.type === 'LargestObject' ? largestFrame + 1
      : filter?.type === 'AbsoluteStart' ? Math.max(Number(filter.startGroup) * GOP_FRAMES, largestFrame + 1)
        : nextGroupStart;
    this.subs.set(requestId, {
      requestId, alias: requestId + 1000n, trackName, startGroup: BigInt(Math.floor(nextFrame / GOP_FRAMES)),
      nextFrame, joiningFrame: largestFrame, priority: Number(subscriberPriority ?? 128),
      acked: false, ackAtUs: this.nowUs + 2 * PATH_DELAY_US, active: true, paused: false,
    });
  }

  /**
   * Put queued frames on the bottleneck link until it is busy past `untilUs`.
   * Each time the link frees, the relay sends the waiting frame with the best
   * subscriber priority, oldest first within a priority. A paused (forward 0)
   * or ended subscription's frames that have not started are never sent.
   */
  private transmit(untilUs: number): void {
    const stopped = (q: Queued) => q.fetch ? this.cancelledFetches.has(q.fetch.requestId) : !q.sub.active || q.sub.paused;
    const priority = (q: Queued) => (this.honoursPriority ? q.fetch?.priority ?? q.sub.priority : 0);
    for (;;) {
      for (let i = this.queued.length - 1; i >= 0; i--) if (stopped(this.queued[i]!)) this.queued.splice(i, 1);
      if (this.queued.length === 0) return;
      const t = Math.max(this.serverFreeUs, Math.min(...this.queued.map(q => q.releaseUs)));
      if (t > untilUs) return;
      let best = -1;
      for (let i = 0; i < this.queued.length; i++) {
        const q = this.queued[i]!;
        if (q.releaseUs > t) continue;
        const b = best < 0 ? undefined : this.queued[best]!;
        if (b === undefined || priority(q) < priority(b) || (priority(q) === priority(b) && q.releaseUs < b.releaseUs)) best = i;
      }
      const [q] = this.queued.splice(best, 1);
      this.serverFreeUs = t + (q!.bytes * 8 * 1_000_000) / (t < this.congestedUntilUs ? this.capacityBps : 30_000_000);
      this.inFlight.push({ ...q!, arrivalUs: Math.round(this.serverFreeUs + PATH_DELAY_US) });
    }
  }

  /** Answer subscriptions, release due frames into the link, deliver arrivals. */
  advanceTo(targetUs: number, setClock: (us: number) => void): void {
    if (this.closed) { setClock(targetUs); return; }
    for (const sub of this.subs.values()) {
      if (sub.acked || sub.ackAtUs > targetUs) continue;
      sub.acked = true;
      this.adapter.onMessage?.({
        type: 'SUBSCRIBE_OK', requestId: varint(sub.requestId), trackAlias: varint(sub.alias),
        // LARGEST_OBJECT (0x09): the track has content once the source starts.
        parameters: new Map(sub.joiningFrame >= 0 ? [[0x09n, [{
          group: BigInt(Math.floor(sub.joiningFrame / GOP_FRAMES)), object: BigInt(sub.joiningFrame % GOP_FRAMES),
        }]]] : []),
        trackExtensions: new Map(),
      } as unknown as ControlMessage);
      if (sub.trackName === 'catalog') {
        const catalogObject: MoqtObject = {
          kind: 'data', trackAlias: sub.alias, groupId: 0n, subgroupId: 0n, objectId: 0n,
          publisherPriority: undefined, payload: new TextEncoder().encode(this.catalog),
        };
        this.adapter.onObject?.(0n, catalogObject);
        sub.active = false;
      }
    }

    // Release every frame that exists by targetUs, in capture order across
    // subscriptions, through one FIFO bottleneck.
    const due: Array<{ sub: Subscription; frameIndex: number; releaseUs: number }> = [];
    for (const sub of this.subs.values()) {
      if (!sub.active || !sub.acked || sub.paused) continue;
      while (sub.nextFrame * FRAME_US <= targetUs) {
        // Already-captured frames (cache) leave as soon as the subscription is live.
        due.push({ sub, frameIndex: sub.nextFrame, releaseUs: Math.max(sub.nextFrame * FRAME_US, sub.ackAtUs) });
        sub.nextFrame++;
      }
    }
    // A Joining FETCH's frames are already cached: all are released at once,
    // in order, on one stream through the same bottleneck.
    const fetched: Array<{ sub: Subscription; frameIndex: number; releaseUs: number; fetch: JoiningFetch }> = [];
    for (const fetch of this.fetches) {
      if (fetch.releaseAtUs > targetUs || this.cancelledFetches.has(fetch.requestId)) continue;
      while (fetch.nextFrame <= fetch.lastFrame) {
        fetched.push({ sub: fetch.sub, frameIndex: fetch.nextFrame, releaseUs: fetch.releaseAtUs, fetch });
        fetch.nextFrame++;
      }
    }
    const rung = (name: string) => LADDER.find(r => r.name === name)!;
    const released: Array<{ sub: Subscription; frameIndex: number; releaseUs: number; fetch?: JoiningFetch }> = [...due, ...fetched];
    for (const d of released.sort((a, b) => a.releaseUs - b.releaseUs)) {
      const bytes = Math.round(frameBytes(rung(d.sub.trackName).bitrateBps, d.frameIndex) * this.contentScale);
      this.queued.push({ sub: d.sub, frameIndex: d.frameIndex, bytes, releaseUs: d.releaseUs,
        ...(d.fetch !== undefined ? { fetch: d.fetch } : {}) });
    }
    this.transmit(targetUs);
    this.inFlight.sort((a, b) => a.arrivalUs - b.arrivalUs);

    while (this.inFlight.length > 0 && this.inFlight[0]!.arrivalUs <= targetUs) {
      const f = this.inFlight.shift()!;
      // An unsubscribed track's streams are reset; nothing more arrives.
      // Its frames still waiting for the link were dropped by transmit().
      // A FETCH outlives its subscription (it has its own request).
      if (f.fetch ? this.cancelledFetches.has(f.fetch.requestId) : !f.sub.active) continue;
      setClock(Math.max(f.arrivalUs, this.nowUs));
      this.carriedBits += f.bytes * 8;
      const groupId = BigInt(Math.floor(f.frameIndex / GOP_FRAMES));
      const objectId = f.frameIndex % GOP_FRAMES;
      const streamId = f.fetch ? f.fetch.streamId : f.sub.requestId * 1_000_000n + groupId;
      if (f.fetch && !f.fetch.started) {
        f.fetch.started = true;
        this.adapter.onDataStream?.(streamId, {
          type: 'fetch', header: { requestId: f.fetch.requestId }, ...(f.fetch.fill ? { fill: true } : {}),
        });
      }
      // Objects on a FETCH stream carry no alias (§10.4.4); the player maps them.
      const wireAlias = f.fetch ? 0n : f.sub.alias;
      // CMAF: one low-latency chunk per frame, with a real moof (tfdt,
      // duration, sync flag) around the frame's bytes.
      const payload = this.packaging === 'cmaf'
        ? buildChunk({
          bmdt: CMAF_ORIGIN_TICKS + BigInt(f.frameIndex * CMAF_FRAME_TICKS),
          samples: [{ duration: CMAF_FRAME_TICKS, size: f.bytes, flags: objectId === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS }],
          mdat: new Uint8Array(f.bytes),
        })
        : new Uint8Array(f.bytes);
      if (this.packaging === 'loc') payload.set([0, 0, 0, 1, objectId === 0 ? 0x65 : 0x41]);
      const frame: MoqtObject = {
        kind: 'data', trackAlias: wireAlias, groupId, subgroupId: 0n, objectId: BigInt(objectId),
        publisherPriority: undefined, payload,
        extensions: this.packaging === 'loc'
          ? encodeLocHeaders({ ...(this.captureTimestamps ? { captureTimestamp: BigInt(PUBLISHER_EPOCH_US + f.frameIndex * FRAME_US) } : {}),
            videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: objectId === 0,
              discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(this.draft) })
          : new Uint8Array(0),
      };
      this.adapter.onObject?.(streamId, frame);
      if (this.packaging === 'loc' && objectId === GOP_FRAMES - 1) {
        const groupEnd: MoqtObject = {
          kind: 'gap', trackAlias: wireAlias, groupId, subgroupId: 0n,
          objectId: BigInt(GOP_FRAMES), status: ObjectStatus.END_OF_GROUP,
        };
        this.adapter.onObject?.(streamId, groupEnd);
      }
      if (f.fetch && f.frameIndex === f.fetch.lastFrame) this.adapter.onStreamClosed?.(streamId, undefined, 'fin');
      // The playout model judges live delivery against capture time. Fetched
      // frames are past media filling a gap, so they stay out of its accounting.
      if (!f.fetch) this.onFrameDelivered?.(f.sub.trackName, f.frameIndex * FRAME_US);
    }
    setClock(targetUs);
  }

  onFrameDelivered: ((trackName: string, captureUs: number) => void) | undefined;

  /** The relay drops the session: in-flight media is lost, and requests fail from now on. */
  close(): void {
    this.closed = true;
    for (const sub of this.subs.values()) sub.active = false;
    this.adapter.onClose?.(0, 'relay closed the session');
  }
}

// ─── Player harness ──────────────────────────────────────────────────

/** Initial playout delay behind capture, and the refill wait after a stall. */
const PLAYOUT_DELAY_US = 500_000;
const REBUFFER_US = 500_000;

interface Scenario {
  readonly congestedUntilUs?: number;
  /** Public manual selections on an ample link to exercise ladder boundaries. */
  readonly selections?: readonly { atUs: number; track: string }[];
  readonly packaging: 'loc' | 'cmaf';
  readonly capacityBps: number;
  readonly durationUs: number;
  /**
   * CMAF only: scripted MSE buffer-ahead (µs) once media has arrived; null =
   * no signal. Before the first video chunk the buffer is always null — MSE
   * cannot hold media that has not been delivered.
   */
  readonly bufferAheadUs?: (nowUs: number) => number | null;
  /**
   * Replace the player's estimator with one that reports the true link
   * capacity. The CONTROL: it shows what the decision logic does when the
   * bandwidth signal is right, so a defect can be pinned on the estimator.
   */
  readonly oracleEstimate?: boolean;
  /** Actual bytes as a fraction of the catalog bitrate. Default 1. */
  readonly contentScale?: number;
  /** LOC: whether frames carry a capture timestamp. Default true. */
  readonly captureTimestamps?: boolean;
  /** Start rung index (0 = top). Default: the player's `auto` (mid-ladder). */
  readonly startLevel?: number;
  /** Extra player configuration. */
  readonly playerConfig?: Partial<MoqtPlayerConfig>;
  /** Draft the relay speaks (default 16). */
  readonly draft?: 14 | 16 | 18 | 22;
  /** How the relay answers a Joining FETCH (default 'serve'). */
  readonly joiningFetch?: 'serve' | 'refuse' | 'stall';
  /** Whether the relay honours subscriber priority (default true). */
  readonly relayPriority?: boolean;
  /** The relay drops the session at this time (µs). */
  readonly closeAtUs?: number;
  /**
   * CMAF: a readable CMAF Header in the catalog (default), or opaque bytes —
   * a header the player cannot parse, which leaves it no delivery-lag signal.
   */
  readonly cmafHeader?: 'real' | 'opaque';
}

interface Run {
  /** Rung playing at the end of the run. */
  readonly finalTrack: string | undefined;
  /** Every committed switch, in order. */
  readonly switches: readonly { atUs: number; from: string; to: string; reason: string }[];
  /** Simulated time of each reported stall (µs). */
  readonly stallsAtUs: readonly number[];
  /** The player's bandwidth estimate at the end of the run (kbps). */
  readonly estimateKbps: number;
  /** Average rate the link actually carried over the run (kbps). */
  readonly carriedKbps: number;
  /** Switches that failed and rolled back. */
  readonly failedSwitches: readonly { atUs: number; from: string; to: string; error: string }[];
  /** Requests the player sent, as the relay saw them. */
  readonly subscribes: SourcePacedRelay['subscribes'];
  readonly updates: SourcePacedRelay['updates'];
  /** Requests the player attempted after the relay closed the session. */
  readonly rejectedAfterClose: number;
  /** Joining FETCHes the player sent. */
  readonly joiningFetches: SourcePacedRelay['joiningFetches'];
  readonly fills: SourcePacedRelay['fills'];
  readonly errors: readonly PlayerError[];
  readonly lastDeliveryUs: ReadonlyMap<string, number>;
  readonly recoveryReservations: number;
  readonly latency: readonly { atUs: number; latencyUs: number }[];
  readonly jumps: readonly number[];
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function runScenario(s: Scenario): Promise<Run> {
  // The player's own timers (switch deadlines, retry delays) run on simulated
  // time, advanced with the clock; otherwise a 60 s run would finish before
  // any of them fired.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const relay = new SourcePacedRelay(s.capacityBps, catalogJson(s.packaging, s.cmafHeader), s.packaging, s.contentScale, s.captureTimestamps,
    s.relayPriority, s.joiningFetch, s.draft);
  relay.congestedUntilUs = s.congestedUntilUs ?? Infinity;
  let clockUs = 0;
  let firstVideoUs: number | null = null;
  const clock = { now: () => clockUs };
  const setClock = (us: number) => { clockUs = us; relay.nowUs = us; };

  const renderer = {
    enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
    onFirstFrame: null as (() => void) | null,
    onFrameRendered: null as ((ts: bigint, r: number) => void) | null,
    onStall: null as ((ms: number) => void) | null,
  };
  const decoder = {
    configure: vi.fn(),
    decode: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    reset: vi.fn(), queueDepth: 0, onFrame: null as any, onError: null as any, destroy: vi.fn(),
  };
  const mediaSource = {
    initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
    mediaElement: null,
    onFirstFrame: null as (() => void) | null,
    onError: null as ((e: Error) => void) | null,
    onStall: null as ((ms: number) => void) | null,
    changeType: vi.fn(() => Promise.resolve()),
    reserveSwitchRecovery: vi.fn(() => null),
    getBufferAheadUs: vi.fn(() => firstVideoUs === null ? null : s.bufferAheadUs?.(clockUs) ?? null),
    // The highest group handed to the assembler stands in for what MSE committed.
    getCommittedGroupFloor: vi.fn((_mt: string, trackName: string) => assembledGroups.get(trackName)?.at(-1)),
  };
  const assembledGroups = new Map<string, bigint[]>();
  const assembler = {
    push: vi.fn((mediaType: string, trackName: string, groupId: bigint) => {
      if (mediaType !== 'video') return;
      const groups = assembledGroups.get(trackName) ?? [];
      if (groups.at(-1) !== groupId) groups.push(groupId);
      assembledGroups.set(trackName, groups);
    }),
    selectTrack: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn(),
  };

  const player = new MoqtPlayer({
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => relay.adapter as unknown as MoqtConnection,
    catalogBootstrap: 'subscribe',
    draftVersion: s.draft ?? 16,
    livenessTimeoutMs: 0, // This model advances media time, not the wall-clock liveness monitor.
    clock,
    ...s.playerConfig,
    ...(s.startLevel !== undefined ? { startLevel: s.startLevel } : {}),
    ...(s.packaging === 'loc'
      ? { createVideoDecoder: () => decoder, createRenderer: () => renderer }
      : { createMediaSource: () => mediaSource as any, createCmafAssembler: callbacks => {
          const real = new CmafAssembler(callbacks);
          const push = real.push.bind(real);
          real.push = (...args) => { assembler.push(args[0], args[1], args[2]); return push(...args); };
          return real;
        } }),
  });
  const internals = player as unknown as {
    readVideoReceivedRate(): number | null;
    subscribedTrack(mediaType: 'video'): { name: string } | undefined;
  };

  const errors: PlayerError[] = [];
  player.on('error', event => { errors.push(event.error); });
  const lastDeliveryUs = new Map<string, number>();
  const switches: Array<{ atUs: number; from: string; to: string; reason: string }> = [];
  player.on('quality_switched', e => switches.push({ atUs: clockUs, from: e.fromTrackName, to: e.toTrackName, reason: e.reason }));
  const failedSwitches: Array<{ atUs: number; from: string; to: string; error: string }> = [];
  player.on('quality_switch_failed', e => failedSwitches.push({ atUs: clockUs, from: e.fromTrackName, to: e.toTrackName, error: e.error.message }));

  // Playout model: a frame of the playing rung is due PLAYOUT_DELAY_US after
  // capture, plus all rebuffering so far. A late frame is a stall: playback
  // waits for it, then refills REBUFFER_US before resuming.
  const stallsAtUs: number[] = [];
  let playoutOffsetUs = PLAYOUT_DELAY_US;
  let rendered = 0n;
  let newestCaptureUs: number | null = null;
  const latency: { atUs: number; latencyUs: number }[] = [];
  const jumps: number[] = [];
  player.on('recovery_action', e => { if (e.action.type === 'jump_to_live' && e.action.trigger === 'latency') jumps.push(clockUs); });
  relay.onFrameDelivered = (trackName, captureUs) => {
    if (trackName === internals.subscribedTrack('video')?.name) newestCaptureUs = captureUs;
    firstVideoUs ??= clockUs;
    lastDeliveryUs.set(trackName, clockUs);
    if (trackName !== internals.subscribedTrack('video')?.name) return;
    const lateUs = clockUs - (captureUs + playoutOffsetUs);
    if (lateUs > 0) {
      playoutOffsetUs += lateUs + REBUFFER_US;
      stallsAtUs.push(clockUs);
      const stallMs = (lateUs + REBUFFER_US) / 1000;
      if (s.packaging === 'loc') renderer.onStall?.(stallMs);
      else mediaSource.onStall?.(stallMs);
    }
    if (rendered === 0n) {
      if (s.packaging === 'loc') renderer.onFirstFrame?.();
      else mediaSource.onFirstFrame?.();
    }
    renderer.onFrameRendered?.(++rendered * BigInt(FRAME_US), clockUs);
  };

  await player.load();
  // An application starts playback; ABR and delivery measurement run only while playing.
  player.play();
  if (s.oracleEstimate) {
    internals.readVideoReceivedRate = () => s.capacityBps / 1000;
  }
  try {
    for (let t = TICK_US; t <= s.durationUs; t += TICK_US) {
      if (s.closeAtUs !== undefined && !relay.closed && t >= s.closeAtUs) relay.close();
      for (const selection of s.selections ?? []) {
        if (selection.atUs > t - TICK_US && selection.atUs <= t) {
          void player.selectVideoTrack(selection.track).catch(() => {});
        }
      }
      relay.advanceTo(t, setClock);
      vi.advanceTimersByTime(TICK_US / 1000);
      player.tick();
      await flushMicrotasks();
      // Read the real shared timeline; the simulated renderer does not schedule frames.
      const sync = (player as unknown as { syncController: import('@openmoq/playback').SyncController | null }).syncController;
      if (sync?.hasReference && newestCaptureUs !== null && t % 500_000 < TICK_US) {
        const timing = sync.computeAudioRenderTime(BigInt(PUBLISHER_EPOCH_US + newestCaptureUs));
        if (timing) latency.push({ atUs: t, latencyUs: timing.renderTimeUs - newestCaptureUs });
      }
    }
    return {
      errors, lastDeliveryUs, latency, jumps, recoveryReservations: mediaSource.reserveSwitchRecovery.mock.calls.length,
      finalTrack: internals.subscribedTrack('video')?.name,
      switches,
      stallsAtUs,
      estimateKbps: internals.readVideoReceivedRate() ?? 0,
      carriedKbps: relay.carriedBits / (s.durationUs / 1_000_000) / 1000,
      failedSwitches,
      subscribes: relay.subscribes,
      updates: relay.updates,
      rejectedAfterClose: relay.rejectedAfterClose,
      joiningFetches: relay.joiningFetches,
      fills: relay.fills,
    };
  } finally {
    await player.destroy();
    vi.useRealTimers();
  }
}

const rungIndex = (name: string | undefined) => LADDER.findIndex(r => r.name === name);
/** `quality: 'auto'` starts mid-ladder. */
const START = 'v1500';
const AMPLE_BPS = 30_000_000; // 5× the top rung
const SECONDS = (n: number) => n * 1_000_000;
/** A low-latency MSE buffer: thin because the player sits near the live edge. */
const LL_BUFFER = () => 300_000;

// ─── Scenarios ───────────────────────────────────────────────────────

describe('ABR under source-paced live delivery', () => {
  describe('harness', () => {
    it('paces delivery at capture rate: the link carries the encoding rate, not its capacity', async () => {
      const run = await runScenario({
        packaging: 'loc', capacityBps: AMPLE_BPS, durationUs: SECONDS(30), oracleEstimate: true,
      });
      // Held at the start rung for the first 15s (upshift stability window),
      // so the average sits between the start rung and the top — far below capacity.
      expect(run.carriedKbps).toBeGreaterThan(1_000);
      expect(run.carriedKbps).toBeLessThan(AMPLE_BPS / 1000 / 4);
      expect(run.stallsAtUs).toEqual([]);
    });
  });

  // Controls: same delivery, decision logic fed a correct bandwidth signal or
  // a genuine congestion signal. They pass today and must keep passing; they
  // are what make the known-defect cases below evidence about the estimator
  // rather than about the harness.
  describe('controls', () => {
    it('LOC: with a correct estimate, climbs to the top rung on an ample link', async () => {
      const run = await runScenario({
        packaging: 'loc', capacityBps: AMPLE_BPS, durationUs: SECONDS(60), oracleEstimate: true,
      });
      expect(run.finalTrack).toBe('v6000');
      expect(run.switches.map(sw => sw.to)).toEqual(['v3000', 'v6000']);
      expect(run.stallsAtUs).toEqual([]);
    });

    it('CMAF: with a correct estimate, a thin low-latency buffer on an ample link holds its rung', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(60),
        bufferAheadUs: LL_BUFFER, oracleEstimate: true,
      });
      expect(run.switches).toEqual([]);
      expect(run.finalTrack).toBe(START);
    });

    // The lag signal must not fire on what a bitrate comparison would misread.
    it.each([
      ['VBR content at 60% of its nominal bitrate, ample link', { capacityBps: AMPLE_BPS, contentScale: 0.6 }],
      ['v1500 on a 1.65 Mbps link (91% utilised)', { capacityBps: 1_650_000 }],
      ['v800 on a 1 Mbps link (80% utilised)', { capacityBps: 1_000_000, startLevel: 3 }],
    ] as const)('LOC: no downshift for %s', async (_label, sc) => {
      const run = await runScenario({ packaging: 'loc', durationUs: SECONDS(60), ...sc });
      expect(run.switches).toEqual([]);
      expect(run.stallsAtUs).toEqual([]);
    });

    it('CMAF: a thin low-latency buffer on an ample link does not downshift', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(60), bufferAheadUs: LL_BUFFER,
      });
      // Delivery lag shows the link keeping up despite the thin live-edge buffer.
      expect(run.switches.filter(sw => rungIndex(sw.to) > rungIndex(sw.from))).toEqual([]);
    });

    it('CMAF: a thin low-latency buffer on an ample link does not ratchet down', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(90), bufferAheadUs: LL_BUFFER,
      });
      // Sustained healthy delivery must not drive repeated downshifts.
      expect(run.stallsAtUs).toEqual([]);
      expect(rungIndex(run.finalTrack)).toBeLessThanOrEqual(rungIndex(START));
    });

    it('CMAF: the estimate is not below the rate actually received', async () => {
      // A healthy buffer, so the player stays on v1500 and only measures.
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(30), bufferAheadUs: () => 2_000_000,
      });
      expect(run.finalTrack).toBe(START);
      // The estimate includes keyframes as well as smaller P-frames.
      expect(run.estimateKbps).toBeGreaterThanOrEqual(1_500 * 0.95);
    });
  });

  // Switching under congestion: request a lower rung while keeping the
  // outgoing subscription available as a fallback, even if the switch fails.
  describe('switching under congestion', () => {
    const switchSubscribes = (run: Run) => run.subscribes.filter(sub => sub.trackName.startsWith('v')).slice(1);

    it.each([14, 16, 18, 22] as const)('draft %s requests a downshift while keeping the outgoing subscription forwarding', async draft => {
      for (const packaging of ['loc', 'cmaf'] as const) {
        const run = await runScenario({ packaging, draft, capacityBps: 1_000_000,
          durationUs: SECONDS(30), bufferAheadUs: LL_BUFFER });
        const target = switchSubscribes(run)[0]!;
        expect(target.trackName).toBe('v800');
        expect(target.atUs).toBeLessThan(SECONDS(10));
        // This assertion checks priority and Forward only; filter updates
        // from stall recovery are outside this test's scope.
        expect(run.updates.filter(u => u.options?.subscriberPriority !== undefined || u.options?.forward !== undefined)).toEqual([]);
        expect(run.errors.filter(error => error.severity === 'fatal')).toEqual([]);
        expect(run.lastDeliveryUs.get(run.finalTrack!)!).toBeGreaterThan(SECONDS(29));
        const healthy = await runScenario({ packaging, draft, capacityBps: AMPLE_BPS,
          durationUs: SECONDS(30), bufferAheadUs: LL_BUFFER });
        expect(healthy.switches).toEqual([]);
        expect(healthy.stallsAtUs).toEqual([]);
      }
    });

    for (const draft of [14, 16, 18, 22] as const) {
      for (const packaging of ['loc', 'cmaf'] as const) {
        it.each([undefined, 64, 200])(`draft ${draft} ${packaging}: a congested downshift lands with priority %s`, async subscriberPriority => {
          const scenario = { packaging, draft, durationUs: SECONDS(30), bufferAheadUs: LL_BUFFER,
            playerConfig: subscriberPriority === undefined ? {} : { subscriberPriority } };
          const healthy = await runScenario({ ...scenario, capacityBps: AMPLE_BPS });
          expect.soft(healthy.switches).toEqual([]);
          expect.soft(healthy.stallsAtUs).toEqual([]);
          expect.soft(healthy.failedSwitches).toEqual([]);
          expect.soft(healthy.finalTrack).toBe(START);
          const run = await runScenario({ ...scenario, capacityBps: 1_000_000 });
          const outgoing = run.subscribes.find(sub => sub.trackName === START)!;
          const target = switchSubscribes(run)[0]!;
          const adoption = run.switches[0]?.atUs ?? Infinity;
          const priority = BigInt((subscriberPriority ?? 128) - 1);
          expect.soft(target.options.subscriberPriority).toBe(priority);
          if (draft === 22) {
            expect.soft(target.options.fill.subscriberPriority).toBe(Number(priority));
            expect.soft(run.fills.map(fill => fill.requestId)).toContain(target.requestId);
          } else {
            const history = run.joiningFetches.filter(fetch => fetch.options.joiningRequestId === target.requestId);
            expect.soft(history).toHaveLength(1);
            expect.soft(history[0]?.options.subscriberPriority).toBe(priority);
          }
          // A declined recovery reservation must never be hidden by a permissive mock.
          expect.soft(run.recoveryReservations).toBe(0);
          expect.soft(target.trackName).toBe('v800');
          expect.soft(run.switches.map(sw => [sw.from, sw.to])).toEqual([[START, 'v800']]);
          expect.soft(run.failedSwitches).toEqual([]);
          expect.soft(run.finalTrack).toBe('v800');
          expect.soft(run.updates.filter(u => u.requestId === outgoing.requestId
            && u.atUs >= target.atUs && u.atUs < adoption)).toEqual([]);
          expect.soft(run.updates.filter(u => u.atUs >= adoption)).toEqual([]);
          expect.soft(run.errors.filter(error => error.severity === 'fatal')).toEqual([]);
          expect.soft(run.lastDeliveryUs.get('v800') ?? 0).toBeGreaterThan(SECONDS(29));
        });
      }
    }

    it.each([
      { subscriberPriority: 0, expected: [0, 0, 0, 0, 0] },
      { subscriberPriority: 1, expected: [1, 1, 1, 1, 1] },
      { subscriberPriority: 64, expected: [64, 63, 63, 64, 63] },
      { subscriberPriority: 64, audioSubscriberPriority: 63, expected: [64, 64, 64, 64, 64] },
      { subscriberPriority: 64, audioSubscriberPriority: 255, expected: [64, 64, 64, 64, 64] },
    ])('priority boundaries and up-switch reset: %o', async ({ expected, ...playerConfig }) => {
      const run = await runScenario({ packaging: 'loc', draft: 22, capacityBps: AMPLE_BPS,
        durationUs: SECONDS(25), playerConfig, selections: [
          { atUs: SECONDS(4), track: 'v800' }, { atUs: SECONDS(9), track: 'v400' },
          { atUs: SECONDS(14), track: START }, { atUs: SECONDS(19), track: 'v800' },
        ] });
      expect(run.failedSwitches).toEqual([]);
      expect(run.switches.map(sw => sw.to)).toEqual(['v800', 'v400', START, 'v800']);
      expect(run.subscribes.filter(sub => sub.trackName.startsWith('v'))
        .map(sub => Number(sub.options?.subscriberPriority ?? 128))).toEqual(expected);
      expect(run.updates).toEqual([]);
    });

    it('after the relay closes the session, ABR stops requesting switches', async () => {
      // An opaque CMAF Header leaves no lag signal, so the thin buffer keeps
      // asking for a downshift; the reconnect is far off, so the closed
      // session stays current for the remainder of the scenario.
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: 1_000_000, durationUs: SECONDS(30), bufferAheadUs: LL_BUFFER,
        cmafHeader: 'opaque', closeAtUs: SECONDS(3), playerConfig: { reconnectDelayMs: 60_000 },
      });
      expect(run.rejectedAfterClose).toBe(0);
    });
  });

  // Known defects. Each states the DESIRED behaviour and is marked `it.fails`
  // because today's player violates it; remove `.fails` as the fix lands. The
  // controls above use the same harness, so a broken harness cannot hide here.
  describe('known defects (it.fails until fixed)', () => {
    it.fails('#1 estimator: measures link capacity, not the encoding rate', async () => {
      const run = await runScenario({ packaging: 'loc', capacityBps: AMPLE_BPS, durationUs: SECONDS(30) });
      // Today: exactly the 1500 kbps being sent, against 30 000 kbps available.
      expect(run.estimateKbps).toBeGreaterThan(AMPLE_BPS / 1000 / 2);
    });

    it.fails('#1 upshift: LOC climbs above the start rung on an ample link', async () => {
      const run = await runScenario({ packaging: 'loc', capacityBps: AMPLE_BPS, durationUs: SECONDS(60) });
      // Today: no switch at all — `bw > 2.25 × next rung` cannot hold when
      // bw is the current rung's own bitrate.
      expect(rungIndex(run.finalTrack)).toBeLessThan(rungIndex(START));
    });
  });
});

describe('LOC latency give-back after real simulated congestion', () => {
  it.each([14, 16, 18, 22] as const)('recovers on draft %i, with disabled and ample controls', async draft => {
    const scenario = { draft, packaging: 'loc' as const, capacityBps: 700_000,
      congestedUntilUs: SECONDS(30), durationUs: SECONDS(70) };
    const enabled = await runScenario(scenario);
    const disabled = await runScenario({ ...scenario, playerConfig: { liveJumpThresholdMs: 0 } });
    const ample = await runScenario({ ...scenario, capacityBps: AMPLE_BPS });
    const latencyAt69 = (run: Run) => run.latency.find(sample => sample.atUs >= SECONDS(69))!.latencyUs;
    expect(disabled.jumps).toEqual([]);
    expect(latencyAt69(disabled)).toBeGreaterThan(4_000_000);
    expect(ample.jumps).toEqual([]);
    expect(latencyAt69(ample)).toBeLessThan(100_000);
    expect.soft(latencyAt69(enabled)).toBeLessThan(1_000_000);
    expect(enabled.jumps).toHaveLength(1);
    expect(enabled.jumps[0]).toBeGreaterThan(enabled.stallsAtUs.at(-1)!);
    for (const run of [enabled, disabled, ample]) {
      expect(run.stallsAtUs.at(-1) ?? 0).toBeLessThan(SECONDS(45));
      expect(run.errors.filter(error => error.severity === 'fatal')).toEqual([]);
    }
  });
});
