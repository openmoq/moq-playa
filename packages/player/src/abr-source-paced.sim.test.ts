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

function catalogJson(packaging: 'loc' | 'cmaf'): string {
  return JSON.stringify({
    version: 1,
    tracks: LADDER.map((r, i) => ({
      name: r.name, packaging, isLive: true, role: 'video', renderGroup: 1, altGroup: 1,
      codec: 'avc1.64001f', width: 320 * (5 - i), height: 180 * (5 - i), bitrate: r.bitrateBps,
      ...(packaging === 'cmaf' ? { initData: Buffer.from(videoInit()).toString('base64') } : {}),
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
  private readonly subs = new Map<bigint, Subscription>();
  private readonly inFlight: InFlight[] = [];
  readonly adapter: any;
  /** Bytes the link carried — the ground truth an estimator should approach. */
  carriedBits = 0;

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
        const requestId = relay.nextRequestId++;
        opts?.onRequestId?.(requestId);
        relay.addSubscription(requestId, new TextDecoder().decode(name), opts?.subscriptionFilter);
        return varint(requestId);
      }),
      requestUpdate: vi.fn(async () => varint(relay.nextRequestId++)),
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

  private liveGroup(): bigint {
    return BigInt(Math.floor(this.nowUs / FRAME_US / GOP_FRAMES));
  }

  private addSubscription(requestId: bigint, trackName: string, filter: any): void {
    // The catalog subscription is answered with the catalog object, not media.
    const startGroup = filter?.type === 'AbsoluteStart' ? BigInt(filter.startGroup) : this.liveGroup() + 1n;
    this.subs.set(requestId, {
      requestId, alias: requestId + 1000n, trackName, startGroup,
      nextFrame: Number(startGroup) * GOP_FRAMES,
      acked: false, ackAtUs: this.nowUs + 2 * PATH_DELAY_US, active: true,
    });
  }

  /** Answer subscriptions, release due frames into the link, deliver arrivals. */
  advanceTo(targetUs: number, setClock: (us: number) => void): void {
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
      if (!sub.active || !sub.acked) continue;
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
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function runScenario(s: Scenario): Promise<Run> {
  const relay = new SourcePacedRelay(s.capacityBps, catalogJson(s.packaging), s.packaging, s.contentScale, s.captureTimestamps);
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
  };
  const assembler = { push: vi.fn(), selectTrack: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() };

  const player = new MoqtPlayer({
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: vi.fn(async () => ({}) as any),
    createConnection: () => relay.adapter as unknown as MoqtConnection,
    catalogBootstrap: 'subscribe',
    clock,
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
  player.on('quality_switched', e => switches.push({ atUs: clockUs, from: e.fromTrackName, to: e.toTrackName, reason: e.reason }));

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
      relay.advanceTo(t, setClock);
      player.tick();
      await flushMicrotasks();
    }
    return {
      finalTrack: internals.subscribedTrack('video')?.name,
      switches,
      stallsAtUs,
      estimateKbps: internals.readVideoReceivedRate() ?? 0,
      carriedKbps: relay.carriedBits / (s.durationUs / 1_000_000) / 1000,
    };
  } finally {
    await player.destroy();
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
