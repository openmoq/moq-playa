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
  active: boolean;
  /** Forward state 0: the relay holds this subscription's objects back. */
  paused: boolean;
}

interface InFlight {
  readonly sub: Subscription;
  readonly frameIndex: number;
  readonly bytes: number;
  readonly arrivalUs: number;
}

/**
 * Mock relay + bottleneck link. Serves every active subscription from its
 * start group at capture pace, serialised through one FIFO server.
 */
class SourcePacedRelay {
  nowUs = 0;
  private nextRequestId = 1n;
  private serverFreeUs = 0;
  readonly subs = new Map<bigint, Subscription>();
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

  constructor(
    private readonly capacityBps: number,
    private readonly catalog: string,
    private readonly packaging: 'loc' | 'cmaf',
    /** Actual bytes as a fraction of the catalog bitrate (VBR undershoot). */
    private readonly contentScale = 1,
    /** Whether LOC frames carry a capture timestamp. */
    private readonly captureTimestamps = true,
  ) {
    const relay = this;
    this.adapter = {
      draftVersion: 16,
      session: { state: 'established', subscribe: vi.fn(() => ({ requestId: varint(1), actions: [] })), close: vi.fn(() => []) },
      onMessage: null, onClose: null, onError: null, onDataStream: null, onObject: null,
      onStreamClosed: null, onDatagram: null, onNamespaceMessage: null, onQlogEvent: null,
      connect: vi.fn(async () => {}),
      subscribe: vi.fn(async (_ns: Uint8Array[], name: Uint8Array, opts?: any) => {
        if (relay.closed) { relay.rejectedAfterClose++; throw new Error('Cannot subscribe in state closed; session must be ESTABLISHED'); }
        const requestId = relay.nextRequestId++;
        relay.subscribes.push({ atUs: relay.nowUs, requestId, trackName: new TextDecoder().decode(name), options: opts });
        opts?.onRequestId?.(requestId);
        relay.addSubscription(requestId, new TextDecoder().decode(name), opts?.subscriptionFilter);
        return varint(requestId);
      }),
      requestUpdate: vi.fn(async (id: bigint, opts?: any) => {
        if (relay.closed) { relay.rejectedAfterClose++; throw new Error('Cannot update in state closed; session must be ESTABLISHED'); }
        relay.updates.push({ atUs: relay.nowUs, requestId: BigInt(id), options: opts });
        const sub = relay.subs.get(BigInt(id));
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

  private addSubscription(requestId: bigint, trackName: string, filter: any): void {
    // The catalog subscription is answered with the catalog object, not media.
    const startGroup = filter?.type === 'AbsoluteStart' ? BigInt(filter.startGroup) : this.liveGroup() + 1n;
    this.subs.set(requestId, {
      requestId, alias: requestId + 1000n, trackName, startGroup,
      nextFrame: Number(startGroup) * GOP_FRAMES,
      acked: false, ackAtUs: this.nowUs + 2 * PATH_DELAY_US, active: true, paused: false,
    });
  }

  /** Answer subscriptions, release due frames into the link, deliver arrivals. */
  advanceTo(targetUs: number, setClock: (us: number) => void): void {
    if (this.closed) { setClock(targetUs); return; }
    for (const sub of this.subs.values()) {
      if (sub.acked || sub.ackAtUs > targetUs) continue;
      sub.acked = true;
      this.adapter.onMessage?.({
        type: 'SUBSCRIBE_OK', requestId: varint(sub.requestId), trackAlias: varint(sub.alias),
        parameters: new Map(), trackExtensions: new Map(),
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
    due.sort((a, b) => a.releaseUs - b.releaseUs);
    const rung = (name: string) => LADDER.find(r => r.name === name)!;
    for (const d of due) {
      const bytes = Math.round(frameBytes(rung(d.sub.trackName).bitrateBps, d.frameIndex) * this.contentScale);
      const start = Math.max(d.releaseUs, this.serverFreeUs);
      this.serverFreeUs = start + (bytes * 8 * 1_000_000) / this.capacityBps;
      this.inFlight.push({ sub: d.sub, frameIndex: d.frameIndex, bytes, arrivalUs: Math.round(this.serverFreeUs + PATH_DELAY_US) });
    }
    this.inFlight.sort((a, b) => a.arrivalUs - b.arrivalUs);

    while (this.inFlight.length > 0 && this.inFlight[0]!.arrivalUs <= targetUs) {
      const f = this.inFlight.shift()!;
      // An unsubscribed track's streams are reset; nothing more arrives. Its
      // link time is NOT returned: the model queues everything at the
      // bottleneck, where a real relay would hold most of it behind QUIC's
      // congestion window and free it on RESET_STREAM. After a switch on a
      // congested link the model is therefore pessimistic.
      if (!f.sub.active) continue;
      setClock(Math.max(f.arrivalUs, this.nowUs));
      this.carriedBits += f.bytes * 8;
      const groupId = BigInt(Math.floor(f.frameIndex / GOP_FRAMES));
      const objectId = f.frameIndex % GOP_FRAMES;
      const streamId = f.sub.requestId * 1_000_000n + groupId;
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
        kind: 'data', trackAlias: f.sub.alias, groupId, subgroupId: 0n, objectId: BigInt(objectId),
        publisherPriority: undefined, payload,
        extensions: this.packaging === 'loc' && this.captureTimestamps
          ? encodeLocHeaders({ captureTimestamp: BigInt(PUBLISHER_EPOCH_US + f.frameIndex * FRAME_US) })
          : new Uint8Array(0),
      };
      this.adapter.onObject?.(streamId, frame);
      if (this.packaging === 'loc' && objectId === GOP_FRAMES - 1) {
        const groupEnd: MoqtObject = {
          kind: 'gap', trackAlias: f.sub.alias, groupId, subgroupId: 0n,
          objectId: BigInt(GOP_FRAMES), status: ObjectStatus.END_OF_GROUP,
        };
        this.adapter.onObject?.(streamId, groupEnd);
      }
      this.onFrameDelivered?.(f.sub.trackName, f.frameIndex * FRAME_US);
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
  /** Requests the player attempted after the relay closed the session. */
  readonly rejectedAfterClose: number;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function runScenario(s: Scenario): Promise<Run> {
  // The player's own timers (switch deadlines, retry delays) run on simulated
  // time, advanced with the clock; otherwise a 60 s run would finish before
  // any of them fired.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const relay = new SourcePacedRelay(s.capacityBps, catalogJson(s.packaging, s.cmafHeader), s.packaging, s.contentScale, s.captureTimestamps);
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
    configure: vi.fn(), decode: vi.fn(), flush: vi.fn(() => Promise.resolve()),
    reset: vi.fn(), queueDepth: 0, onFrame: null as any, onError: null as any, destroy: vi.fn(),
  };
  const mediaSource = {
    initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
    mediaElement: null,
    onFirstFrame: null as (() => void) | null,
    onError: null as ((e: Error) => void) | null,
    onStall: null as ((ms: number) => void) | null,
    changeType: vi.fn(() => Promise.resolve()),
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
    clock,
    ...s.playerConfig,
    ...(s.startLevel !== undefined ? { startLevel: s.startLevel } : {}),
    ...(s.packaging === 'loc'
      ? { createVideoDecoder: () => decoder, createRenderer: () => renderer }
      : { createMediaSource: () => mediaSource as any, createCmafAssembler: () => assembler as any }),
  });
  const internals = player as unknown as {
    bandwidthEstimator: { recordGroup(b: number, t: number): void; getEstimateKbps(): number; reset(): void } | null;
    subscribedTrack(mediaType: 'video'): { name: string } | undefined;
  };

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
  if (s.oracleEstimate) {
    internals.bandwidthEstimator = { recordGroup() {}, getEstimateKbps: () => s.capacityBps / 1000, reset() {} };
  }
  try {
    for (let t = TICK_US; t <= s.durationUs; t += TICK_US) {
      if (s.closeAtUs !== undefined && !relay.closed && t >= s.closeAtUs) relay.close();
      relay.advanceTo(t, setClock);
      vi.advanceTimersByTime(TICK_US / 1000);
      player.tick();
      await flushMicrotasks();
    }
    return {
      finalTrack: internals.subscribedTrack('video')?.name,
      switches,
      stallsAtUs,
      estimateKbps: internals.bandwidthEstimator?.getEstimateKbps() ?? 0,
      carriedKbps: relay.carriedBits / (s.durationUs / 1_000_000) / 1000,
      failedSwitches,
      subscribes: relay.subscribes,
      updates: relay.updates,
      assembledGroups,
      rejectedAfterClose: relay.rejectedAfterClose,
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
        packaging: 'cmaf', capacityBps: 1_000_000, durationUs: SECONDS(60), bufferAheadUs: LL_BUFFER,
      });
      // The MSE stall callback downshifts at once, so the first step may come
      // from either path; the lag path must still get through the thin buffer.
      expect(run.switches.length).toBeGreaterThan(0);
      expect(run.switches[0]!.atUs).toBeLessThan(SECONDS(10));
      expect(run.switches.some(sw => sw.reason === 'bandwidth')).toBe(true);
      expect(LADDER[rungIndex(run.finalTrack)]!.bitrateBps).toBeLessThan(1_000_000);
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
      // Formerly NextGroupStart: the live edge, however far behind playback was.
      expect(switchSubscribes(run)[0]!.options.subscriptionFilter.type).toBe('AbsoluteStart');
      const from = run.assembledGroups.get(run.switches[0]!.from)!;
      const to = run.assembledGroups.get(run.switches[0]!.to)!;
      expect(to[0]!).toBeLessThanOrEqual(from.at(-1)! + 1n);
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
      const run = await runScenario({
        packaging: 'loc', capacityBps: 1_000_000, durationUs: SECONDS(60), captureTimestamps: false,
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
      expect(options.subscriptionFilter.type).toBe('AbsoluteStart');
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

  describe('measurement', () => {
    it('CMAF: one bandwidth sample per group reads the full received rate', async () => {
      // A healthy buffer, so the player stays on v1500 and only measures.
      const run = await runScenario({
        packaging: 'cmaf', capacityBps: AMPLE_BPS, durationUs: SECONDS(30), bufferAheadUs: () => 2_000_000,
      });
      expect(run.finalTrack).toBe(START);
      // Formerly ≈80% of 1500 kbps: one sample per frame-sized object, smoothed
      // with EWMA, tracked the P-frame rate and averaged the keyframes away.
      expect(run.estimateKbps).toBeGreaterThanOrEqual(1_500 * 0.95);
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
