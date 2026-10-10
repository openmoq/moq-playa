/**
 * Sustained multi-namespace relay load smoke.
 *
 * Reproduces the reported topology: one publisher and one subscriber in each
 * namespace. The relay runs in a separate process so client-side work cannot
 * block its event loop. Correctness is enforced; timing is reported rather
 * than asserted because it depends on the host running the benchmark.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance as nodePerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { MoqtConnection, TrackSubscription } from '@openmoq/webtransport';
import { PublishDoneCode } from '@openmoq/transport';
import { connectClient, type ClientHandle } from './client.js';
import { certsExist } from './cert.js';
import { DEMO_TRACK, nsBytes, te } from './demo.js';
import { startRelayServer } from './server.js';

const RELAY_CHILD_ARG = '--relay-child';
const RELAY_NAMESPACES_ENV = 'RELAY_LOAD_NAMESPACES';
const PUBLISH_ALIAS = 9n;
const SETUP_TIMEOUT_MS = 10_000;
const log = (...args: unknown[]) => console.log('[namespace-load]', ...args);

interface Settings {
  readonly pairs: number;
  readonly durationMs: number;
  readonly groupsPerSecond: number;
  readonly bitsPerSecondPerPublisher: number;
  readonly stallThresholdMs: number;
  readonly duplicateObservationMs: number;
}

interface Observation {
  readonly namespace: readonly string[];
  readonly sourceId: number;
  readonly expectedPayloadBytes: number;
  readonly sentAt: Array<number | undefined>;
  readonly publisherDriftMs: number[];
  readonly publisherServiceMs: number[];
  readonly arrivalTimes: number[];
  readonly deliveryLagMs: number[];
  readonly seen: Set<number>;
  readonly closedGroups: Set<number>;
  duplicates: number;
  malformed: number;
  resolveDone: () => void;
  readonly done: Promise<void>;
}

interface PairState {
  readonly namespace: readonly string[];
  readonly subscriber: ClientHandle;
  readonly publisher: ClientHandle;
  readonly observation: Observation;
  readonly payload: Uint8Array;
  subscription?: TrackSubscription;
  publishRequestId?: bigint;
}

interface StreamSummary {
  readonly namespace: string;
  readonly received: number;
  readonly closed: number;
  readonly duplicates: number;
  readonly malformed: number;
  readonly missing: number[];
  readonly lagP95Ms: number;
  readonly lagMaxMs: number;
  readonly gapMaxMs: number;
  readonly stalls: number;
  readonly publisherDriftMaxMs: number;
}

interface RunSummary {
  readonly pairs: number;
  readonly groupsPerStream: number;
  readonly payloadBytes: number;
  readonly elapsedMs: number;
  readonly effectiveMbps: number;
  readonly streams: StreamSummary[];
  readonly deliveryLagMs: number[];
  readonly arrivalGapsMs: number[];
  readonly publisherDriftMs: number[];
  readonly publisherServiceMs: number[];
}

interface RunOutcome {
  readonly summary: RunSummary;
  readonly failure?: Error;
}

interface IsolatedRelay {
  readonly url: string;
  readonly failure: Promise<never>;
  stop(): Promise<void>;
}

export class RuntimeFailureMonitor {
  private rejectFailure!: (error: Error) => void;
  private failureReason: Error | undefined;
  readonly failure = new Promise<never>((_, reject) => { this.rejectFailure = reject; });

  constructor() {
    void this.failure.catch(() => undefined);
  }

  watch(failure: Promise<never>, label: string): void {
    void failure.catch((error: unknown) => {
      if (this.failureReason !== undefined) return;
      const cause = asError(error);
      this.failureReason = new Error(`${label}: ${cause.message}`, { cause });
      this.rejectFailure(this.failureReason);
    });
  }

  race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.failure]);
  }

  get reason(): Error | undefined {
    return this.failureReason;
  }
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function settings(): Settings {
  return {
    pairs: positiveInteger('LOAD_PAIRS', 8),
    durationMs: positiveInteger('LOAD_DURATION_MS', 10_000),
    groupsPerSecond: positiveInteger('LOAD_GROUPS_PER_SECOND', 20),
    bitsPerSecondPerPublisher: positiveInteger('LOAD_BITS_PER_SECOND', 2_000_000),
    stallThresholdMs: positiveInteger('LOAD_STALL_THRESHOLD_MS', 250),
    duplicateObservationMs: positiveInteger('LOAD_DUPLICATE_OBSERVATION_MS', 1_000),
  };
}

function namespaceFor(index: number): readonly string[] {
  return ['load', `stream-${index}`];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label} (${timeoutMs}ms)`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function createObservation(
  namespace: readonly string[],
  expectedGroups: number,
  sourceId: number,
  expectedPayloadBytes: number,
): Observation {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  return {
    namespace,
    sourceId,
    expectedPayloadBytes,
    sentAt: new Array<number | undefined>(expectedGroups),
    publisherDriftMs: [],
    publisherServiceMs: [],
    arrivalTimes: [],
    deliveryLagMs: [],
    seen: new Set(),
    closedGroups: new Set(),
    duplicates: 0,
    malformed: 0,
    resolveDone,
    done,
  };
}

function settleObservation(obs: Observation, expectedGroups: number): void {
  if (obs.seen.size === expectedGroups && obs.closedGroups.size === expectedGroups) {
    obs.resolveDone();
  }
}

export function recordObject(obs: Observation, expectedGroups: number, value: {
  readonly kind: string;
  readonly groupId?: bigint;
  readonly subgroupId?: bigint;
  readonly objectId?: bigint;
  readonly payload?: Uint8Array;
}): void {
  if (value.kind !== 'data') return;
  if (value.groupId === undefined || value.subgroupId !== BigInt(obs.sourceId)
      || value.objectId !== 0n
      || value.groupId < 0n || value.groupId >= BigInt(expectedGroups)) {
    obs.malformed += 1;
    return;
  }
  if (value.payload === undefined
      || value.payload.byteLength !== obs.expectedPayloadBytes
      || value.payload.byteLength < 4
      || new DataView(
        value.payload.buffer,
        value.payload.byteOffset,
        value.payload.byteLength,
      ).getUint32(0) !== obs.sourceId) {
    obs.malformed += 1;
    return;
  }
  const group = Number(value.groupId);
  if (obs.seen.has(group)) {
    obs.duplicates += 1;
    return;
  }
  obs.seen.add(group);
  const arrivedAt = performance.now();
  obs.arrivalTimes.push(arrivedAt);
  const sentAt = obs.sentAt[group];
  if (sentAt !== undefined) obs.deliveryLagMs.push(arrivedAt - sentAt);
  else obs.malformed += 1;
  settleObservation(obs, expectedGroups);
}

export function recordSubgroupClosed(obs: Observation, expectedGroups: number, value: {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
}): void {
  if (value.subgroupId !== BigInt(obs.sourceId) || value.groupId < 0n
      || value.groupId >= BigInt(expectedGroups)) {
    obs.malformed += 1;
    return;
  }
  const group = Number(value.groupId);
  if (obs.closedGroups.has(group)) {
    obs.malformed += 1;
    return;
  }
  obs.closedGroups.add(group);
  settleObservation(obs, expectedGroups);
}

async function waitForPublishAcceptance(
  conn: MoqtConnection,
  requestId: bigint,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const publish = conn.session.getOutgoingPublish(requestId);
    if (publish?.isTerminated) {
      throw new Error(`PUBLISH ${requestId} terminated before acceptance`);
    }
    if (publish !== undefined && !publish.isPending) return;
    if (performance.now() >= deadline) {
      throw new Error(`timeout: PUBLISH ${requestId} acceptance (${timeoutMs}ms)`);
    }
    await delay(5);
  }
}

async function publishGroups(
  pair: PairState,
  startAt: number,
  intervalMs: number,
  groupCount: number,
  payload: Uint8Array,
): Promise<void> {
  for (let group = 0; group < groupCount; group++) {
    const target = startAt + group * intervalMs;
    await delay(target - performance.now());
    const started = performance.now();
    pair.observation.sentAt[group] = started;
    pair.observation.publisherDriftMs.push(Math.max(0, started - target));
    const streamId = await pair.publisher.conn.openSubgroup(
      PUBLISH_ALIAS,
      BigInt(group),
      BigInt(pair.observation.sourceId),
      { publisherPriority: 128, firstObject: true },
    );
    await pair.publisher.conn.sendObject(streamId, 0n, payload);
    await pair.publisher.conn.closeSubgroup(streamId);
    pair.observation.publisherServiceMs.push(performance.now() - started);
  }
}

export function sourcePayload(sourceId: number, payloadBytes: number): Uint8Array {
  const payload = new Uint8Array(payloadBytes).fill(0x78);
  new DataView(payload.buffer).setUint32(0, sourceId);
  return payload;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function max(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function arrivalGaps(arrivals: readonly number[]): number[] {
  const ordered = [...arrivals].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) gaps.push(ordered[i]! - ordered[i - 1]!);
  return gaps;
}

function summarizeStream(
  obs: Observation,
  expectedGroups: number,
  stallThresholdMs: number,
): StreamSummary {
  const missing: number[] = [];
  for (let group = 0; group < expectedGroups; group++) {
    if (!obs.seen.has(group)) missing.push(group);
  }
  const gaps = arrivalGaps(obs.arrivalTimes);
  return {
    namespace: obs.namespace.join('/'),
    received: obs.seen.size,
    closed: obs.closedGroups.size,
    duplicates: obs.duplicates,
    malformed: obs.malformed,
    missing,
    lagP95Ms: percentile(obs.deliveryLagMs, 0.95),
    lagMaxMs: max(obs.deliveryLagMs),
    gapMaxMs: max(gaps),
    stalls: gaps.filter((gap) => gap >= stallThresholdMs).length,
    publisherDriftMaxMs: max(obs.publisherDriftMs),
  };
}

function printSummary(name: string, summary: RunSummary, stallThresholdMs: number): void {
  const totalExpected = summary.pairs * summary.groupsPerStream;
  const totalReceived = summary.streams.reduce((sum, stream) => sum + stream.received, 0);
  log(`\n${name}: ${summary.pairs} namespace pair(s), ${summary.groupsPerStream} groups/stream, ${summary.payloadBytes} B/group`);
  log(`  delivered ${totalReceived}/${totalExpected} in ${summary.elapsedMs.toFixed(0)}ms (${summary.effectiveMbps.toFixed(2)} Mbps payload egress)`);
  log(`  delivery lag p50/p95/max: ${percentile(summary.deliveryLagMs, 0.5).toFixed(1)} / ${percentile(summary.deliveryLagMs, 0.95).toFixed(1)} / ${max(summary.deliveryLagMs).toFixed(1)} ms`);
  log(`  arrival gap p95/max: ${percentile(summary.arrivalGapsMs, 0.95).toFixed(1)} / ${max(summary.arrivalGapsMs).toFixed(1)} ms; stalls >= ${stallThresholdMs}ms: ${summary.arrivalGapsMs.filter((gap) => gap >= stallThresholdMs).length}`);
  log(`  publisher drift p95/max: ${percentile(summary.publisherDriftMs, 0.95).toFixed(1)} / ${max(summary.publisherDriftMs).toFixed(1)} ms`);
  log(`  publisher open+send+FIN p95/max: ${percentile(summary.publisherServiceMs, 0.95).toFixed(1)} / ${max(summary.publisherServiceMs).toFixed(1)} ms`);
  for (const stream of summary.streams) {
    log(`  ${stream.namespace}: received=${stream.received} closed=${stream.closed}/${summary.groupsPerStream} missing=${stream.missing.length} duplicate=${stream.duplicates} malformed=${stream.malformed} lag-p95/max=${stream.lagP95Ms.toFixed(1)}/${stream.lagMaxMs.toFixed(1)}ms gap-max=${stream.gapMaxMs.toFixed(1)}ms stalls=${stream.stalls} publisher-drift-max=${stream.publisherDriftMaxMs.toFixed(1)}ms`);
  }
}

export async function stopChild(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  const checkExit = (code: number | null, signal: string | null) => {
    if (code !== 0 || signal !== null) {
      throw new Error(`relay child shutdown failed (code=${code}, signal=${signal})`);
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    checkExit(child.exitCode, child.signalCode);
    return;
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.kill('SIGTERM');
  let result: Awaited<typeof exited>;
  try {
    result = await withDeadline(exited, timeoutMs, 'relay child shutdown');
  } catch (error) {
    child.kill('SIGKILL');
    await withDeadline(exited, timeoutMs, 'forced relay child shutdown');
    throw error;
  }
  checkExit(result.code, result.signal);
}

export function observeUnexpectedChildTermination(
  child: Pick<ChildProcess, 'once'>,
  isStopping: () => boolean,
): Promise<never> {
  const failure = new Promise<never>((_, reject) => {
    child.once('error', (error) => {
      if (!isStopping()) reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!isStopping()) {
        reject(new Error(`relay child exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });
  });
  void failure.catch(() => undefined);
  return failure;
}

async function startIsolatedRelay(namespaces: readonly (readonly string[])[]): Promise<IsolatedRelay> {
  const entry = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, ['--import=tsx', entry, RELAY_CHILD_ARG], {
    env: { ...process.env, [RELAY_NAMESPACES_ENV]: JSON.stringify(namespaces) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffered = '';
  let settled = false;
  let stopping = false;
  const failure = observeUnexpectedChildTermination(child, () => stopping);
  const ready = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!settled) reject(new Error(`relay child exited before ready (code=${code}, signal=${signal})`));
    });
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) log(`[relay] ${line}`);
        if (line.startsWith('RELAY_LOAD_READY=')) {
          settled = true;
          resolve(line.slice('RELAY_LOAD_READY='.length));
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.trim().split('\n')) {
        if (line.length > 0) log(`[relay stderr] ${line}`);
      }
    });
  });

  try {
    const url = await withDeadline(ready, 15_000, 'isolated relay startup');
    return {
      url,
      failure,
      stop: async () => {
        stopping = true;
        await stopChild(child);
      },
    };
  } catch (error) {
    stopping = true;
    await stopChild(child);
    throw error;
  }
}

type ClosableClient = { close(): Promise<void>; transport: { closed: Promise<unknown> } };

export async function closeClient(handle: ClosableClient, timeoutMs = 3_000): Promise<void> {
  const closed = Promise.resolve(handle.transport.closed);
  await withDeadline(Promise.all([
    Promise.resolve().then(() => handle.close()),
    closed,
  ]), timeoutMs, 'client shutdown');
}

export async function withAbortDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await withDeadline(
      start(controller.signal),
      timeoutMs,
      label,
    );
  } catch (error) {
    controller.abort();
    throw error;
  }
}

async function connectClientBounded(url: string, label: string, runtime: RuntimeFailureMonitor): Promise<ClientHandle> {
  return withAbortDeadline(
    (signal) => runtime.race(connectClient(url, { signal })),
    SETUP_TIMEOUT_MS,
    label,
  );
}

export async function shutdownTopology(
  pairs: readonly { subscription?: Pick<TrackSubscription, 'unsubscribe'> }[],
  clients: readonly ClosableClient[],
  stopRelay: () => Promise<void>,
  runtime?: RuntimeFailureMonitor,
): Promise<void> {
  const errors: unknown[] = [];
  const subscriptionShutdowns = pairs.flatMap((pair) => {
    if (pair.subscription === undefined) return [];
    return [withDeadline(Promise.resolve().then(() => pair.subscription!.unsubscribe()), 3_000, 'subscription shutdown')];
  });
  const subscriptions = await Promise.allSettled(subscriptionShutdowns);
  const connections = await Promise.allSettled(clients.map((client) => closeClient(client)));
  for (const result of [...subscriptions, ...connections]) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  try { await stopRelay(); } catch (error) { errors.push(error); }
  if (runtime?.reason !== undefined) errors.push(runtime.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, `topology shutdown failed: ${errors.map((error) => asError(error).message).join('; ')}`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function runTopology(pairCount: number, config: Settings): Promise<RunOutcome> {
  const namespaces = Array.from({ length: pairCount }, (_, index) => namespaceFor(index));
  const relay = await startIsolatedRelay(namespaces);
  const intervalMs = 1_000 / config.groupsPerSecond;
  const groupCount = Math.max(1, Math.floor(config.durationMs / intervalMs));
  const payloadBytes = Math.max(
    4,
    Math.floor(config.bitsPerSecondPerPublisher / 8 / config.groupsPerSecond),
  );
  const pairs: PairState[] = [];
  const clients: ClientHandle[] = [];
  const runtime = new RuntimeFailureMonitor();
  runtime.watch(relay.failure, 'relay process failed');
  let operationFailure: unknown;
  let outcome: RunOutcome;

  try {
    for (const [sourceId, namespace] of namespaces.entries()) {
      const subscriber = await connectClientBounded(
        relay.url,
        `${namespace.join('/')} subscriber connect`,
        runtime,
      );
      clients.push(subscriber);
      runtime.watch(subscriber.failure, `${namespace.join('/')} subscriber failed`);
      const publisher = await connectClientBounded(
        relay.url,
        `${namespace.join('/')} publisher connect`,
        runtime,
      );
      clients.push(publisher);
      runtime.watch(publisher.failure, `${namespace.join('/')} publisher failed`);
      pairs.push({
        namespace,
        subscriber,
        publisher,
        observation: createObservation(namespace, groupCount, sourceId, payloadBytes),
        payload: sourcePayload(sourceId, payloadBytes),
      });
    }

    await runtime.race(Promise.all(pairs.map(async (pair) => {
      pair.subscription = await withDeadline(
        pair.subscriber.conn.subscribeTrack(
          nsBytes([...pair.namespace]),
          te(DEMO_TRACK),
          {
            onObject: (value) => recordObject(pair.observation, groupCount, value),
            onSubgroupClosed: (value) => recordSubgroupClosed(
              pair.observation,
              groupCount,
              value,
            ),
          },
        ),
        SETUP_TIMEOUT_MS,
        `${pair.namespace.join('/')} SUBSCRIBE acceptance`,
      );
    })));

    await runtime.race(Promise.all(pairs.map(async (pair) => {
      const requestId = await withDeadline(
        pair.publisher.conn.publish(
          nsBytes([...pair.namespace]),
          te(DEMO_TRACK),
          PUBLISH_ALIAS,
        ),
        SETUP_TIMEOUT_MS,
        `${pair.namespace.join('/')} PUBLISH write`,
      );
      pair.publishRequestId = requestId;
      await waitForPublishAcceptance(pair.publisher.conn, requestId);
    })));

    const startAt = performance.now() + 500;
    let completedAt = startAt;
    let failure: Error | undefined;
    try {
      await runtime.race(withDeadline(
        Promise.all(pairs.map((pair) => publishGroups(
          pair,
          startAt,
          intervalMs,
          groupCount,
          pair.payload,
        ))).then(() => undefined),
        Math.max(30_000, config.durationMs * 3),
        `${pairCount} namespace publishers to finish`,
      ));
      await runtime.race(withDeadline(
        Promise.all(pairs.map((pair) => pair.observation.done)).then(() => undefined),
        Math.max(20_000, config.durationMs * 2),
        `${pairCount} namespace streams and subgroup FINs to arrive`,
      ));
      completedAt = performance.now();
      await runtime.race(withDeadline(
        Promise.all(pairs.map(async (pair) => {
          if (pair.publishRequestId !== undefined) {
            await pair.publisher.conn.publishDone(
              pair.publishRequestId,
              PublishDoneCode.TRACK_ENDED,
              'load complete',
            );
          }
        })).then(() => undefined),
        5_000,
        'publisher shutdown',
      ));
      await runtime.race(delay(config.duplicateObservationMs));
      await runtime.race(withDeadline(
        Promise.all(pairs.map(async (pair) => {
          const subscription = pair.subscription;
          if (subscription === undefined) return;
          await subscription.unsubscribe();
          delete pair.subscription;
        })).then(() => undefined),
        5_000,
        'subscriber shutdown',
      ));
    } catch (error) {
      completedAt = performance.now();
      failure = runtime.reason ?? asError(error);
      await delay(Math.min(250, config.duplicateObservationMs));
    }

    failure ??= runtime.reason;
    operationFailure = failure;

    const streams = pairs.map((pair) => summarizeStream(
      pair.observation,
      groupCount,
      config.stallThresholdMs,
    ));
    const deliveryLagMs = pairs.flatMap((pair) => pair.observation.deliveryLagMs);
    const arrivalGapsMs = pairs.flatMap((pair) => arrivalGaps(pair.observation.arrivalTimes));
    const publisherDriftMs = pairs.flatMap((pair) => pair.observation.publisherDriftMs);
    const publisherServiceMs = pairs.flatMap((pair) => pair.observation.publisherServiceMs);
    const elapsedMs = completedAt - startAt;
    const delivered = streams.reduce((sum, stream) => sum + stream.received, 0);
    const summary: RunSummary = {
      pairs: pairCount,
      groupsPerStream: groupCount,
      payloadBytes,
      elapsedMs,
      effectiveMbps: delivered * payloadBytes * 8 / Math.max(1, elapsedMs) / 1_000,
      streams,
      deliveryLagMs,
      arrivalGapsMs,
      publisherDriftMs,
      publisherServiceMs,
    };
    outcome = failure === undefined ? { summary } : { summary, failure };
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    try {
      await shutdownTopology(pairs, clients, () => relay.stop(), runtime);
    } catch (error) {
      if (operationFailure !== undefined) {
        throw new AggregateError([operationFailure, error],
          `${asError(operationFailure).message}; ${asError(error).message}`);
      }
      throw error;
    }
  }
  return outcome;
}

function assertCorrect(summary: RunSummary): void {
  const bad = summary.streams.filter((stream) =>
    stream.closed !== summary.groupsPerStream
      || stream.missing.length > 0 || stream.duplicates > 0 || stream.malformed > 0);
  if (bad.length > 0) {
    throw new Error(`delivery errors in ${bad.map((stream) => stream.namespace).join(', ')}`);
  }
}

async function main(): Promise<number> {
  if (!certsExist()) {
    log('Missing ./certs; run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
    return 1;
  }
  const config = settings();
  log(`host: Node ${process.version} ${process.platform}/${process.arch}, ${availableParallelism()} available CPU(s), ${(totalmem() / 1024 ** 3).toFixed(1)} GiB RAM`);
  log(`workload: ${config.durationMs}ms, ${config.groupsPerSecond} groups/s, ${(config.bitsPerSecondPerPublisher / 1_000_000).toFixed(2)} Mbps per publisher`);
  log(`duplicate observation: ${config.duplicateObservationMs}ms after all expected subgroup FINs`);
  log('relay runs in a separate process; one subscriber and one publisher connection per namespace');

  const baselineOutcome = await runTopology(1, config);
  const baseline = baselineOutcome.summary;
  printSummary('baseline', baseline, config.stallThresholdMs);
  if (baselineOutcome.failure !== undefined) throw baselineOutcome.failure;
  assertCorrect(baseline);

  const loadedOutcome = await runTopology(config.pairs, config);
  const loaded = loadedOutcome.summary;
  printSummary('loaded', loaded, config.stallThresholdMs);
  if (loadedOutcome.failure !== undefined) throw loadedOutcome.failure;
  assertCorrect(loaded);

  const baselineLag = percentile(baseline.deliveryLagMs, 0.95);
  const loadedLag = percentile(loaded.deliveryLagMs, 0.95);
  const baselineGap = percentile(baseline.arrivalGapsMs, 0.95);
  const loadedGap = percentile(loaded.arrivalGapsMs, 0.95);
  log(`\nscaling: delivery-lag p95 ${(loadedLag / Math.max(0.001, baselineLag)).toFixed(2)}x; arrival-gap p95 ${(loadedGap / Math.max(0.001, baselineGap)).toFixed(2)}x`);
  log(`RESULT: all expected groups and FINs arrived; no duplicate was observed through the ${config.duplicateObservationMs}ms post-FIN window. Review timing above for host-specific slowdown. PASS.`);
  return 0;
}

function parseChildNamespaces(): readonly (readonly string[])[] {
  const raw = process.env[RELAY_NAMESPACES_ENV];
  if (raw === undefined) throw new Error(`${RELAY_NAMESPACES_ENV} is required in relay-child mode`);
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length === 0
      || value.some((namespace) => !Array.isArray(namespace)
        || namespace.length === 0
        || namespace.some((field) => typeof field !== 'string'))) {
    throw new Error(`${RELAY_NAMESPACES_ENV} must be a non-empty JSON array of namespace tuples`);
  }
  return value as string[][];
}

async function runRelayChild(): Promise<void> {
  const registeredNamespaces = parseChildNamespaces();
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  const loopUtilizationStart = nodePerformance.eventLoopUtilization();
  const cpuStart = process.cpuUsage();
  const wallStart = nodePerformance.now();
  loopDelay.enable();
  const relay = await startRelayServer({
    port: 0,
    relayOptions: { registeredNamespaces },
  });
  console.log(`RELAY_LOAD_READY=${relay.url}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await relay.stop();
  loopDelay.disable();
  const loopUtilization = nodePerformance.eventLoopUtilization(loopUtilizationStart);
  const cpu = process.cpuUsage(cpuStart);
  console.log(
    'RELAY_PROCESS_LIFECYCLE_RUNTIME'
      + ` event_loop_utilization=${loopUtilization.utilization.toFixed(4)}`
      + ` event_loop_delay_p95_ms=${(loopDelay.percentile(95) / 1e6).toFixed(2)}`
      + ` event_loop_delay_max_ms=${(loopDelay.max / 1e6).toFixed(2)}`
      + ` cpu_ms=${((cpu.user + cpu.system) / 1_000).toFixed(1)}`
      + ` wall_ms=${(nodePerformance.now() - wallStart).toFixed(1)}`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes(RELAY_CHILD_ARG)) {
    runRelayChild()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[namespace-load relay] failed:', (error as Error).message);
        process.exit(1);
      });
  } else {
    main()
      .then((code) => process.exit(code))
      .catch((error) => {
        console.error('[namespace-load] crashed:', (error as Error).message);
        process.exit(1);
      });
  }
}
