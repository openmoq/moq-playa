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
 * Boundary: transport, decoder, renderer and MSE are fakes on one simulated
 * clock. Every rendered-frame callback is synthesized on arrival, and the MSE
 * buffer depth is scripted — the suite tests the ABR DECISION, not playout.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import type { MoqtConnection } from '@openmoq/webtransport';
import type { ControlMessage, MoqtObject } from '@openmoq/transport';
import { varint, ObjectStatus } from '@openmoq/transport';
import { encodeLocHeaders } from '@openmoq/loc';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, videoInit } from '../../locmaf/test-support/cmaf.js';
import { isSyncSampleFlags, parseLocmafTrackContext, readCmafChunkSamples } from '@openmoq/locmaf';

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
  private nextRequestId = 1n;
  private serverFreeUs = 0;
  readonly subs = new Map<bigint, Subscription>();
  /** Frames released by the relay and waiting for the bottleneck link. */
  private readonly queued: Queued[] = [];
  private readonly inFlight: InFlight[] = [];
  readonly adapter: any;
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
  private readonly fetches: JoiningFetch[] = [];

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
    private readonly draft22 = false,
  ) {
    const relay = this;
    this.adapter = {
      draftVersion: draft22 ? 22 : 16,
      session: { state: 'established', subscribe: vi.fn(() => ({ requestId: varint(1), actions: [] })), close: vi.fn(() => []) },
      onMessage: null, onClose: null, onError: null, onDataStream: null, onObject: null,
      onStreamClosed: null, onDatagram: null, onNamespaceMessage: null, onQlogEvent: null,
      connect: vi.fn(async () => {}),
      subscribe: vi.fn(async (_ns: Uint8Array[], name: Uint8Array, opts?: any) => {
        if (relay.closed) { relay.rejectedAfterClose++; throw new Error('Cannot subscribe in state closed; session must be ESTABLISHED'); }
        const requestId = relay.nextRequestId++;
        relay.subscribes.push({ atUs: relay.nowUs, requestId, trackName: new TextDecoder().decode(name), options: opts });
        opts?.onRequestId?.(requestId);
        relay.addSubscription(requestId, new TextDecoder().decode(name), opts?.subscriptionFilter, opts?.subscriberPriority);
        const fillStart = opts?.fill?.filter?.type === 'AbsoluteStart' ? Number(opts.fill.filter.startGroup) * GOP_FRAMES : undefined;
        const sub = relay.subs.get(requestId)!;
        if (relay.draft22 && fillStart !== undefined && fillStart <= sub.joiningFrame) {
          // The fill stream bears the SUBSCRIBE's Request ID.
          relay.fills.push({ atUs: relay.nowUs, requestId, startGroup: BigInt(opts.fill.filter.startGroup) });
          relay.fetches.push({
            requestId, streamId: requestId * 1_000_000n + 999_999n, sub, nextFrame: fillStart, lastFrame: sub.joiningFrame,
            releaseAtUs: relay.nowUs + 2 * PATH_DELAY_US, priority: sub.priority, started: false, fill: true,
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
        return varint(relay.nextRequestId++);
      }),
      unsubscribe: vi.fn(async (id: bigint) => {
        const sub = relay.subs.get(BigInt(id));
        if (sub) sub.active = false;
      }),
      fetch: vi.fn(async () => varint(relay.nextRequestId++)),
      // Absolute Joining FETCH (draft-18 §10.12.2): the subscription's groups
      // from Joining Start up to its Joining Location, served from cache.
      joiningFetch: vi.fn(async (opts: any) => {
        if (relay.closed) { relay.rejectedAfterClose++; throw new Error('Cannot fetch in state closed; session must be ESTABLISHED'); }
        const requestId = relay.nextRequestId++;
        opts?.onRequestId?.(requestId);
        relay.joiningFetches.push({ atUs: relay.nowUs, requestId, options: opts });
        const sub = relay.subs.get(BigInt(opts.joiningRequestId));
        const first = Number(opts.joiningStart) * GOP_FRAMES;
        if (relay.draft22) throw new Error('draft-22 has no Joining FETCH');
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
      fetchCancel: vi.fn(async () => {}),
      trackStatus: vi.fn(async (_ns: unknown, _n: unknown, opts?: { onRequestId?: (id: bigint) => void }) => {
        const id = relay.nextRequestId++;
        opts?.onRequestId?.(id);
        return varint(id);
      }),
      subscribeNamespace: vi.fn(async () => varint(relay.nextRequestId++)),
      cancelNamespace: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
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
    const stopped = (q: Queued) => q.fetch === undefined && (!q.sub.active || q.sub.paused);
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
      this.serverFreeUs = t + (q!.bytes * 8 * 1_000_000) / this.capacityBps;
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
      if (fetch.releaseAtUs > targetUs) continue;
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
      if (f.fetch ? this.closed : !f.sub.active) continue;
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
      const frame: MoqtObject = {
        kind: 'data', trackAlias: wireAlias, groupId, subgroupId: 0n, objectId: BigInt(objectId),
        publisherPriority: undefined, payload,
        extensions: this.packaging === 'loc' && this.captureTimestamps
          ? encodeLocHeaders({ captureTimestamp: BigInt(PUBLISHER_EPOCH_US + f.frameIndex * FRAME_US) })
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
  readonly draft?: 16 | 22;
  /** LOC: the mock decoder outputs each frame, so the renderer sees render times. */
  readonly decoderOutput?: boolean;
  /** Slip the player's playout clock by this much at this time, as absorbing late audio does. */
  readonly slipAt?: { readonly atUs: number; readonly byUs: number };
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
  /** CMAF: groups handed to the assembler, per track, in order. */
  readonly assembledGroups: ReadonlyMap<string, readonly bigint[]>;
  /** CMAF: the first chunk handed to the assembler per track — its group, and whether it starts with a sync sample. */
  readonly firstAssembled: ReadonlyMap<string, { readonly group: bigint; readonly sync: boolean }>;
  /** LOC with `decoderOutput`: each frame's playout latency (render time − capture time) when queued for rendering. */
  readonly enqueuedLatency: readonly { readonly atUs: number; readonly latencyUs: number }[];
  /** Every catch_up_changed event, and the rates set on the media element (CMAF). */
  readonly catchUps: readonly { readonly atUs: number; readonly active: boolean; readonly rate: number }[];
  readonly elementRates: readonly number[];
  /** CMAF: tracks whose open groups the player told the media source were abandoned. */
  readonly abandonedTracks: readonly string[];
  /** Every recovery action the player reported. */
  readonly recoveryActions: readonly { readonly atUs: number; readonly action: any }[];
  /** LOC: each frame's capture age (decode time − capture time) when handed to the decoder. */
  readonly decodedAges: readonly { readonly atUs: number; readonly ageUs: number }[];
  /** LOC: each keyframe handed to the decoder — its group, and when (µs). */
  readonly decodedKeys: readonly { readonly group: bigint; readonly atUs: number }[];
  /** Requests the player attempted after the relay closed the session. */
  readonly rejectedAfterClose: number;
  /** Joining FETCHes the player sent. */
  readonly joiningFetches: SourcePacedRelay['joiningFetches'];
  readonly fills: SourcePacedRelay['fills'];
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
    s.relayPriority, s.joiningFetch, s.draft === 22);
  let clockUs = 0;
  let firstVideoUs: number | null = null;
  const clock = { now: () => clockUs };
  const setClock = (us: number) => { clockUs = us; relay.nowUs = us; };

  // Playout latency of each frame the renderer was given: render time − capture time.
  const enqueuedLatency: { atUs: number; latencyUs: number }[] = [];
  const renderer = {
    enqueue: vi.fn((frame: { timestamp: number }, renderTimeUs: number) => {
      enqueuedLatency.push({ atUs: clockUs, latencyUs: renderTimeUs - (frame.timestamp - PUBLISHER_EPOCH_US) });
    }),
    flush: vi.fn(), destroy: vi.fn(), retime: vi.fn(),
    onFirstFrame: null as (() => void) | null,
    onFrameRendered: null as ((ts: bigint, r: number) => void) | null,
    onStall: null as ((ms: number) => void) | null,
  };
  const decodedKeys: { group: bigint; atUs: number }[] = [];
  const decodedAges: { atUs: number; ageUs: number }[] = [];
  const decoder = {
    configure: vi.fn(),
    decode: vi.fn((chunk: { type: string; timestamp: number }, renderTimeUs: number, token?: object, timing?: unknown) => {
      decodedAges.push({ atUs: clockUs, ageUs: clockUs - (chunk.timestamp - PUBLISHER_EPOCH_US) });
      if (s.decoderOutput) decoder.onFrame?.({ timestamp: chunk.timestamp, close() {} }, renderTimeUs, undefined, token, timing);
      if (chunk.type !== 'key') return;
      const frame = Math.round((chunk.timestamp - PUBLISHER_EPOCH_US) / FRAME_US);
      decodedKeys.push({ group: BigInt(Math.floor(frame / GOP_FRAMES)), atUs: clockUs });
    }),
    flush: vi.fn(() => Promise.resolve()),
    reset: vi.fn(), queueDepth: 0, onFrame: null as any, onError: null as any, destroy: vi.fn(),
  };
  const elementRates: number[] = [];
  const abandonedTracks: string[] = [];
  const mediaSource = {
    initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
    mediaElement: null,
    onFirstFrame: null as (() => void) | null,
    onError: null as ((e: Error) => void) | null,
    onStall: null as ((ms: number) => void) | null,
    changeType: vi.fn(() => Promise.resolve()),
    getBufferAheadUs: vi.fn(() => firstVideoUs === null ? null : s.bufferAheadUs?.(clockUs) ?? null),
    setPlaybackRate: vi.fn((rate: number) => { elementRates.push(rate); }),
    abandonReceivingGroups: vi.fn((_mt: string, trackName: string) => { abandonedTracks.push(trackName); }),
    // The highest group handed to the assembler stands in for what MSE committed.
    getCommittedGroupFloor: vi.fn((_mt: string, trackName: string) => assembledGroups.get(trackName)?.at(-1)),
  };
  const assembledGroups = new Map<string, bigint[]>();
  const firstAssembled = new Map<string, { group: bigint; sync: boolean }>();
  const cmafContext = parseLocmafTrackContext(videoInit());
  const assembler = {
    push: vi.fn((mediaType: string, trackName: string, groupId: bigint, payload?: Uint8Array) => {
      if (mediaType !== 'video') return;
      if (!firstAssembled.has(trackName) && payload) {
        let sync = false;
        try { sync = isSyncSampleFlags(readCmafChunkSamples(payload, cmafContext).effective.flags[0]!); } catch { /* not a parseable chunk */ }
        firstAssembled.set(trackName, { group: groupId, sync });
      }
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
    clock,
    ...s.playerConfig,
    ...(s.startLevel !== undefined ? { startLevel: s.startLevel } : {}),
    ...(s.packaging === 'loc'
      ? { createVideoDecoder: () => decoder, createRenderer: () => renderer }
      : { createMediaSource: () => mediaSource as any, createCmafAssembler: () => assembler as any }),
  });
  const internals = player as unknown as {
    readVideoReceivedRate(): number | null;
    subscribedTrack(mediaType: 'video'): { name: string } | undefined;
  };

  const switches: Array<{ atUs: number; from: string; to: string; reason: string }> = [];
  const recoveryActions: { atUs: number; action: any }[] = [];
  const catchUps: { atUs: number; active: boolean; rate: number }[] = [];
  player.on('catch_up_changed', e => catchUps.push({ atUs: clockUs, active: e.active, rate: e.rate }));
  player.on('recovery_action', e => recoveryActions.push({ atUs: clockUs, action: e.action }));
  player.on('quality_switched', e => switches.push({ atUs: clockUs, from: e.fromTrackName, to: e.toTrackName, reason: e.reason }));
  const failedSwitches: Array<{ atUs: number; from: string; to: string; error: string }> = [];
  player.on('quality_switch_failed', e => failedSwitches.push({ atUs: clockUs, from: e.fromTrackName, to: e.toTrackName, error: e.error.message }));

  // Playout model: a frame of the playing rung is due PLAYOUT_DELAY_US after
  // capture, plus all rebuffering so far. A late frame is a stall: playback
  // waits for it, then refills REBUFFER_US before resuming.
  const stallsAtUs: number[] = [];
  let playoutOffsetUs = PLAYOUT_DELAY_US;
  let rendered = 0n;
  relay.onFrameDelivered = (trackName, captureUs) => {
    firstVideoUs ??= clockUs;
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
      if (s.slipAt !== undefined && t >= s.slipAt.atUs && t < s.slipAt.atUs + TICK_US) {
        (player as unknown as { syncController: { slipReference(us: number): void } }).syncController.slipReference(s.slipAt.byUs);
      }
      relay.advanceTo(t, setClock);
      vi.advanceTimersByTime(TICK_US / 1000);
      player.tick();
      await flushMicrotasks();
    }
    return {
      finalTrack: internals.subscribedTrack('video')?.name,
      switches,
      stallsAtUs,
      estimateKbps: internals.readVideoReceivedRate() ?? 0,
      carriedKbps: relay.carriedBits / (s.durationUs / 1_000_000) / 1000,
      failedSwitches,
      subscribes: relay.subscribes,
      updates: relay.updates,
      assembledGroups,
      firstAssembled,
      decodedKeys,
      decodedAges,
      enqueuedLatency,
      recoveryActions,
      catchUps,
      elementRates,
      abandonedTracks,
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

    it('LOC without capture timestamps: a link below the encoding rate stalls, and the stalls step quality down', async () => {
      // No lag signal, so this is the last-resort path: the player's own
      // default recovery controller, which must be built with a clock or its
      // windowed stall escalation never fires.
      const run = await runScenario({
        packaging: 'loc', capacityBps: 1_000_000, durationUs: SECONDS(60), captureTimestamps: false,
      });
      expect(run.stallsAtUs.length).toBeGreaterThan(0);
      expect(run.switches.length).toBeGreaterThan(0);
      expect(run.switches.every(sw => rungIndex(sw.to) > rungIndex(sw.from))).toBe(true);
      expect(LADDER[rungIndex(run.finalTrack)]!.bitrateBps).toBeLessThan(1_000_000);
    });

    it('LOC: rising delivery lag steps quality down well before stall escalation would', async () => {
      const run = await runScenario({ packaging: 'loc', capacityBps: 1_000_000, durationUs: SECONDS(60) });
      // Stalls alone first step down at ~24s. The first stall itself cannot be
      // beaten: 0.5s of playout buffer at 50% overload lasts ~1s, less than a
      // group-aligned switch takes to land.
      expect(run.switches[0]).toMatchObject({ from: START, to: 'v800', reason: 'bandwidth' });
      expect(run.switches[0]!.atUs).toBeLessThan(SECONDS(10));
      expect(LADDER[rungIndex(run.finalTrack)]!.bitrateBps).toBeLessThan(1_000_000);
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
      // Formerly v1500 → v800 → v400 within ~4s: the `bw > 1.5 × current`
      // exemption for thin-but-fed buffers never applies at the live edge.
      // Delivery lag now shows the link keeping up.
      expect(run.switches.filter(sw => rungIndex(sw.to) > rungIndex(sw.from))).toEqual([]);
    });

    it('CMAF: a thin low-latency buffer on an ample link does not ratchet down', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(90), bufferAheadUs: LL_BUFFER,
      });
      // Formerly ended on v400, the lowest rung, with no stall to justify it.
      expect(run.stallsAtUs).toEqual([]);
      expect(rungIndex(run.finalTrack)).toBeLessThanOrEqual(rungIndex(START));
    });

    it('CMAF: a thin buffer still steps down when delivery lag shows the link falling behind', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: 700_000, durationUs: SECONDS(60), bufferAheadUs: LL_BUFFER,
      });
      // The MSE stall callback downshifts at once, so the first step may come
      // from either path; the lag path must still get through the thin buffer.
      expect(run.switches.length).toBeGreaterThan(0);
      expect(run.switches[0]!.atUs).toBeLessThan(SECONDS(10));
      expect(run.switches.some(sw => sw.reason === 'bandwidth')).toBe(true);
      expect(LADDER[rungIndex(run.finalTrack)]!.bitrateBps).toBeLessThan(1_000_000);
    });

    it('CMAF: the estimate is not below the rate actually received', async () => {
      // A healthy buffer, so the player stays on v1500 and only measures.
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(30), bufferAheadUs: () => 2_000_000,
      });
      expect(run.finalTrack).toBe(START);
      // Per-object EWMA sampling once read ≈80%, tracking the P-frame rate.
      expect(run.estimateKbps).toBeGreaterThanOrEqual(1_500 * 0.95);
    });
  });

  // Switching under congestion: the target must get through a link that is
  // already behind, without the outgoing rung's backlog shutting it out.
  describe('switching under congestion', () => {
    const initialVideo = (run: Run) => run.subscribes.find(sub => sub.trackName === START)!;
    const switchSubscribes = (run: Run) => run.subscribes.filter(sub => sub.trackName.startsWith('v')).slice(1);

    it('CMAF: a switch continues from the group after the last one MSE committed', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: 1_000_000, durationUs: SECONDS(40), bufferAheadUs: LL_BUFFER,
      });
      // A SUBSCRIBE never replays the past (the mock relay follows draft-18
      // §10.7), so the target subscribes from the Largest Object and fetches
      // the groups after the committed one with an Absolute Joining FETCH.
      const target = switchSubscribes(run)[0]!;
      expect(target.options.subscriptionFilter.type).toBe('LargestObject');
      const fill = run.joiningFetches.find(f => BigInt(f.options.joiningRequestId) === target.requestId);
      expect(fill?.options).toMatchObject({ joiningFetchType: 'absolute' });
      const from = run.assembledGroups.get(run.switches[0]!.from)!;
      const to = run.assembledGroups.get(run.switches[0]!.to)!;
      // The fill reached MSE first, whole: the target's first chunk is the
      // keyframe of the group it fetched from — the group after the one MSE
      // had committed — and no hole opens after the outgoing rung's last
      // group. Without the fill the target began mid-group, from the Largest
      // Object, with deltas MSE cannot use until the next keyframe.
      expect(run.firstAssembled.get(run.switches[0]!.to)).toEqual({ group: BigInt(fill!.options.joiningStart), sync: true });
      expect(to[0]!).toBeLessThanOrEqual(from.at(-1)! + 1n);
    });

    it.each([16, 22] as const)('CMAF (draft %s): downshifts from far above the link leave no hole between rungs', async draft => {
      // Starting at v6000 on 1 Mbps, playback falls more than a group behind
      // live before each downshift. Every target continues from the group after
      // the committed one — by Joining FETCH, or on draft 22 a fill on the
      // SUBSCRIBE — so no group is skipped.
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: 1_000_000, durationUs: SECONDS(40), bufferAheadUs: LL_BUFFER, startLevel: 0, draft,
      });
      expect(run.switches.length).toBeGreaterThanOrEqual(2);
      const groups = [...new Set([...run.assembledGroups.values()].flat())].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const missing = groups.slice(1).flatMap((g, k) => (g - groups[k]! > 1n ? [groups[k]! + 1n] : []));
      expect(missing).toEqual([]);
      if (draft === 22) {
        // The fill rides on each switch SUBSCRIBE; one starting past the Largest Object is empty.
        expect(switchSubscribes(run).map(sub => sub.options.fill?.filter?.type)).toEqual(run.switches.map(() => 'AbsoluteStart'));
        expect(run.fills.length).toBeGreaterThan(0);
        expect(run.joiningFetches).toEqual([]);
      } else {
        expect(run.joiningFetches.length).toBe(run.switches.length);
      }
      for (const sw of run.switches) expect(run.firstAssembled.get(sw.to)?.sync).toBe(true);
      // Each committed switch abandons the outgoing track's open groups, so MSE
      // may cross a hole they leave.
      for (const sw of run.switches) expect(run.abandonedTracks).toContain(sw.from);
    });

    it.each(['refuse', 'stall'] as const)('CMAF: when the relay %ss the gap fill, downshifts still land from the live edge', async mode => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: 1_000_000, durationUs: SECONDS(40), bufferAheadUs: LL_BUFFER, startLevel: 0,
        joiningFetch: mode,
      });
      expect(run.joiningFetches.length).toBeGreaterThan(0);
      expect(run.failedSwitches).toEqual([]);
      expect(LADDER[rungIndex(run.finalTrack)]!.bitrateBps).toBeLessThan(1_000_000);
      for (const sw of run.switches) expect(run.firstAssembled.get(sw.to)?.sync).toBe(true);
    });

    it.each([[1_000_000, undefined], [1_000_000, 0], [850_000, undefined]] as const)('PROBEAGE %s %s', async (cap, startLevel) => {
      const run = await runScenario({ packaging: 'loc', capacityBps: cap, durationUs: SECONDS(60), ...(startLevel !== undefined ? { startLevel } : {}) });
      const at = (sec: number) => run.decodedAges.filter(a => a.atUs >= SECONDS(sec)).at(0)?.ageUs;
      console.log('AGE', cap, startLevel, JSON.stringify(run.switches.map(x => [(x.atUs / 1e6).toFixed(1), x.to])), [10, 20, 30, 40, 50, 59].map(t => ((at(t) ?? NaN) / 1e6).toFixed(2)).join(' '), 'stalls', run.stallsAtUs.length);
    });

    it.each([3000, 0])('LOC: playout latency added under congestion is given back (liveJumpThresholdMs %s)', async threshold => {
      // At 10 s the clock slips 6 s later, as absorbing late audio does; the
      // link is ample, so the media then stands buffered well ahead of playout.
      // Catch-up is off, so the jump alone is measured.
      const run = await runScenario({
        packaging: 'loc', capacityBps: AMPLE_BPS, durationUs: SECONDS(30), decoderOutput: true,
        slipAt: { atUs: SECONDS(10), byUs: 6_000_000 }, playerConfig: { liveJumpThresholdMs: threshold, maxCatchUpRate: 1 },
      });
      const latencyAt = (sec: number) => run.enqueuedLatency.filter(f => f.atUs >= SECONDS(sec)).at(0)!.latencyUs;
      expect(latencyAt(9)).toBeLessThan(1_000_000);
      expect(latencyAt(10.5)).toBeGreaterThan(6_000_000);
      const jumps = run.recoveryActions.filter(r => r.action.type === 'jump_to_live');
      if (threshold === 0) {
        expect(jumps).toEqual([]);
        expect(latencyAt(29)).toBeGreaterThan(6_000_000);
      } else {
        expect(jumps).toHaveLength(1);
        expect(jumps[0]!.action).toMatchObject({ trigger: 'latency' });
        // Sustained for a second past the threshold, then the jump.
        expect(jumps[0]!.atUs).toBeGreaterThan(SECONDS(11));
        expect(jumps[0]!.atUs).toBeLessThan(SECONDS(12));
        expect(latencyAt(20)).toBeLessThan(1_000_000);
        expect(latencyAt(29)).toBeLessThan(1_000_000);
      }
    });

    it.each([1.05, 1])('LOC: a smaller excess drains by playing faster (maxCatchUpRate %s)', async maxCatchUpRate => {
      // A 2 s slip, under the 3 s jump threshold: catch-up drains it.
      const run = await runScenario({
        packaging: 'loc', capacityBps: AMPLE_BPS, durationUs: SECONDS(60), decoderOutput: true,
        slipAt: { atUs: SECONDS(10), byUs: 2_000_000 }, playerConfig: { maxCatchUpRate },
      });
      const latencyAt = (sec: number) => run.enqueuedLatency.filter(f => f.atUs >= SECONDS(sec)).at(0)!.latencyUs;
      expect(latencyAt(10.5)).toBeGreaterThan(2_000_000);
      expect(run.recoveryActions.filter(r => r.action.type === 'jump_to_live')).toEqual([]);
      if (maxCatchUpRate === 1) {
        expect(run.catchUps).toEqual([]);
        expect(latencyAt(59)).toBeGreaterThan(2_000_000);
      } else {
        expect(run.catchUps[0]).toMatchObject({ active: true, rate: 1.05 });
        expect(run.catchUps.at(-1)).toMatchObject({ active: false, rate: 1 });
        // 1.45 s of excess at 5% takes about 29 s.
        expect(run.catchUps.at(-1)!.atUs).toBeGreaterThan(SECONDS(35));
        expect(latencyAt(59)).toBeLessThan(1_000_000);
      }
    });

    it('CMAF: a buffer refilled in bursts does not toggle catch-up', async () => {
      // Each fragment lifts the buffer from 0.5 s to 1.1 s; between arrivals it
      // drains back. Nothing stands ahead beyond the floor, so the rate stays 1.
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(20),
        bufferAheadUs: now => 500_000 + (now % 600_000),
      });
      expect(run.catchUps).toEqual([]);
      expect(run.elementRates).toEqual([]);
    });

    it('CMAF: catch-up sets the media element\'s rate while the buffer stands high', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(20), bufferAheadUs: now => (now > SECONDS(10) ? 2_500_000 : 300_000),
      });
      expect(run.elementRates).toEqual([1.05]);
      expect(run.catchUps[0]!.atUs).toBeGreaterThan(SECONDS(10));
    });

    it('LOC: a downshift continues decoding from the group after the current one', async () => {
      const run = await runScenario({ packaging: 'loc', capacityBps: 1_000_000, durationUs: SECONDS(40), startLevel: 0 });
      // Some switches start at the live edge, where there is nothing to fill
      // (the fill is refused); at least one starts a group or more behind it.
      const fill = run.joiningFetches.find(f => run.decodedKeys.some(k => k.atUs < f.atUs));
      expect(fill?.options).toMatchObject({ joiningFetchType: 'absolute' });
      const current = run.decodedKeys.filter(k => k.atUs < fill!.atUs).at(-1)!.group;
      expect(BigInt(fill!.options.joiningStart)).toBe(current + 1n);
      const next = run.decodedKeys.find(k => k.atUs >= fill!.atUs && k.group > current)!;
      expect(next.group).toBe(current + 1n);
    });

    it('a downshift first lowers the outgoing rung\'s priority', async () => {
      const run = await runScenario({ packaging: 'loc', capacityBps: 1_000_000, durationUs: SECONDS(30) });
      const outgoing = initialVideo(run).requestId;
      const lowered = run.updates.find(u => u.requestId === outgoing && u.options?.subscriberPriority !== undefined);
      expect(BigInt(lowered!.options.subscriberPriority)).toBe(129n);
      expect(lowered!.atUs).toBeLessThan(run.switches[0]!.atUs);
    });

    it('a downshift stuck behind the backlog pauses the outgoing rung, and lands', async () => {
      // No capture timestamps: no lag to size the backlog by, so the switch
      // must rely on the paused rung's arrivals showing the link still draining.
      // The relay ignores priority, so lowering the outgoing rung's is not enough.
      const run = await runScenario({
        packaging: 'loc', capacityBps: 1_000_000, durationUs: SECONDS(60), captureTimestamps: false, relayPriority: false,
      });
      const outgoing = initialVideo(run).requestId;
      expect(run.updates.some(u => u.requestId === outgoing && Number(u.options?.forward) === 0)).toBe(true);
      expect(run.failedSwitches).toEqual([]);
      expect(run.switches[0]).toMatchObject({ from: START, to: 'v800' });
    });

    it('switch subscriptions keep the configured subscribe parameters', async () => {
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: 1_000_000, durationUs: SECONDS(30), bufferAheadUs: LL_BUFFER,
        playerConfig: { deliveryTimeoutMs: 2_000, subscriberPriority: 100 },
      });
      const options = switchSubscribes(run)[0]!.options;
      expect(options.subscriptionFilter.type).toBe('LargestObject');
      expect(BigInt(options.deliveryTimeout)).toBe(2_000n);
      expect(BigInt(options.subscriberPriority)).toBe(100n);
      const outgoing = initialVideo(run).requestId;
      expect(run.updates.some(u => u.requestId === outgoing && BigInt(u.options?.subscriberPriority ?? 0) === 101n)).toBe(true);
    });

    it('after the relay closes the session, ABR stops requesting switches', async () => {
      // An opaque CMAF Header leaves no lag signal, so the thin buffer keeps
      // asking for a downshift; the reconnect is far off, so the closed
      // session stays current. Formerly: a rejected switch on every tick.
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: 1_000_000, durationUs: SECONDS(30), bufferAheadUs: LL_BUFFER,
        cmafHeader: 'opaque', closeAtUs: SECONDS(3), playerConfig: { reconnectDelayMs: 60_000 },
      });
      expect(run.rejectedAfterClose).toBeLessThanOrEqual(2);
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
