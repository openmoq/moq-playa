import dgram from 'node:dgram';
import { writeFile } from 'node:fs/promises';

const clock = () => performance.now();
// Lateness histogram: 10 us buckets up to 100 ms, then one overflow bucket.
const BUCKET_MS = 0.01;
const BUCKETS = 10000;

/** mulberry32: the same seed gives the same draw sequence. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default bottleneck queue: the larger of 100 ms at rate and one 2*delay BDP, never below two MTUs. */
export function defaultQueueBytes(rateBps, delayMs = 0) {
  return Math.max(3000, Math.ceil(rateBps / 8 * Math.max(0.1, 2 * delayMs / 1000)));
}

function validateLink(options) {
  const { rateBps, delayMs = 0, jitterMs = 0, lossPct = 0, queueBytes, schedule = [] } = options;
  const shaped = rateBps !== undefined && rateBps !== null && rateBps !== Infinity;
  if (shaped && !(rateBps > 0)) throw new Error(`rateBps must be positive: ${rateBps}`);
  for (const [name, value] of [['delayMs', delayMs], ['jitterMs', jitterMs]]) {
    if (!(value >= 0) || !Number.isFinite(value)) throw new Error(`${name} must be a finite non-negative number`);
  }
  if (!(lossPct >= 0 && lossPct <= 100)) throw new Error('lossPct must be within [0, 100]');
  if (queueBytes !== undefined && !(queueBytes > 0)) throw new Error('queueBytes must be positive');
  if (schedule.length && !shaped) throw new Error('A capacity schedule needs a base rateBps');
  let previous = 0;
  for (const step of schedule) {
    if (!(step.atMs >= previous) || !(step.rateBps > 0)) throw new Error('schedule must be [{atMs, rateBps}] in time order with positive rates');
    previous = step.atMs;
  }
  return { shaped, rateBps: shaped ? rateBps : null, delayMs, jitterMs, lossPct, schedule: schedule.map(step => ({ ...step })),
    queueBytes: shaped ? queueBytes ?? defaultQueueBytes(rateBps, delayMs) : null };
}

/**
 * One shaped direction: random loss, a tail-drop queue in front of a
 * serializer at `rateBps`, then a fixed delay line with non-reordering jitter.
 *
 * Every time is computed from a virtual clock, not from timer wakeups: a
 * packet's serialization starts when the previous one finished (or when it
 * arrived, if the link was idle), so a late timer only delays the send of
 * packets already due and never shifts the next due time. Each packet consumes
 * exactly two random draws (loss, jitter), so a seed fixes both sequences by
 * packet index whatever the queue does.
 *
 * Schedule times are relative to the first packet the link sees, so "drop to
 * 1 Mbps after 20 s" means 20 s into the session, not into process startup.
 */
export function createLink(options = {}, { seed = 1, recordPackets = false, maxRecords = 200000, sampleIntervalMs = 100, spinMs = 1 } = {}) {
  const params = validateLink(options);
  const random = seededRandom(seed);
  const startedAt = clock();
  let origin = null;
  let index = 0;
  let busyUntil = -Infinity;
  let lastDue = -Infinity;
  // Packets admitted to the bottleneck whose serialization has not finished.
  const backlog = [];
  let backlogHead = 0;
  let backlogBytes = 0;
  // Serialized packets waiting out their propagation delay, in due order.
  const line = [];
  let lineHead = 0;
  let timer = null;
  let immediate = null;
  let closed = false;
  const counters = { offeredPackets: 0, offeredBytes: 0, deliveredPackets: 0, deliveredBytes: 0,
    lossPackets: 0, lossBytes: 0, tailPackets: 0, tailBytes: 0 };
  const lateness = new Uint32Array(BUCKETS + 1);
  let latenessSum = 0;
  let latenessMax = 0;
  let firstSend = null;
  let firstSendSize = 0;
  let lastSend = null;
  let maxQueueBytes = 0;
  let maxQueuePackets = 0;
  const records = recordPackets ? [] : null;
  const timeline = [];
  let sampledBytes = 0;
  let sampledAt = startedAt;

  // Rate in force at absolute time `t`, and the absolute time it ends.
  const segment = (t) => {
    let rate = params.rateBps;
    let until = Infinity;
    for (const step of params.schedule) {
      const at = origin + step.atMs;
      if (t >= at) rate = step.rateBps;
      else { until = at; break; }
    }
    return { rate, until };
  };
  // Finish time of `bits` serialized from `start`, integrating across schedule steps.
  const serialize = (start, bits) => {
    let t = start;
    let remaining = bits;
    for (;;) {
      const { rate, until } = segment(t);
      const needMs = remaining / rate * 1000;
      if (t + needMs <= until) return t + needMs;
      remaining -= (until - t) * rate / 1000;
      t = until;
    }
  };
  const prune = (t) => {
    while (backlogHead < backlog.length && backlog[backlogHead].finish <= t) backlogBytes -= backlog[backlogHead++].size;
    if (backlogHead > 1024 && backlogHead * 2 > backlog.length) { backlog.splice(0, backlogHead); backlogHead = 0; }
  };
  const record = (entry) => { if (records && records.length < maxRecords) records.push(entry); };
  const rel = (t) => t - startedAt;

  const arm = () => {
    if (closed || timer || immediate || lineHead >= line.length) return;
    const wait = line[lineHead].due - clock();
    // Node timers have millisecond granularity and fire late; poll the last
    // `spinMs` on the check phase instead of overshooting by a whole tick.
    // That costs a core while a fast link is busy; 0 trades ~1.5 ms p99
    // lateness for idle CPU, and also fares better on an oversubscribed host.
    if (wait <= spinMs) immediate = setImmediate(flush);
    else timer = setTimeout(flush, Math.max(1, Math.floor(wait - spinMs)));
  };
  const flush = () => {
    timer = null;
    immediate = null;
    if (closed) return;
    while (lineHead < line.length) {
      const item = line[lineHead];
      const t = clock();
      if (item.due > t) break;
      lineHead++;
      item.deliver(item.packet);
      const late = Math.max(0, t - item.due);
      lateness[Math.min(BUCKETS, Math.floor(late / BUCKET_MS))]++;
      latenessSum += late;
      latenessMax = Math.max(latenessMax, late);
      counters.deliveredPackets++;
      counters.deliveredBytes += item.size;
      sampledBytes += item.size;
      if (firstSend === null) { firstSend = t; firstSendSize = item.size; }
      lastSend = t;
      if (item.record) { item.record.actualMs = rel(t); item.record.lateMs = late; }
    }
    if (lineHead > 1024 && lineHead * 2 > line.length) { line.splice(0, lineHead); lineHead = 0; }
    arm();
  };

  const sampler = setInterval(() => {
    const t = clock();
    prune(t);
    const elapsed = t - sampledAt;
    timeline.push({ tMs: Math.round(rel(t)), queueBytes: backlogBytes, queuePackets: backlog.length - backlogHead,
      inFlightPackets: line.length - lineHead, deliveredBps: elapsed > 0 ? Math.round(sampledBytes * 8000 / elapsed) : 0,
      rateBps: params.shaped && origin !== null ? segment(t).rate : params.rateBps });
    sampledBytes = 0;
    sampledAt = t;
  }, sampleIntervalMs);
  sampler.unref();

  return {
    params,
    /** Offer one packet; `deliver(packet)` is called when it leaves the link. */
    enqueue(packet, deliver) {
      if (closed) return;
      const t = clock();
      origin ??= t;
      const size = packet.length;
      const lossDraw = random();
      const jitterDraw = random();
      const entry = records ? { index, size, enqueuedMs: rel(t) } : null;
      index++;
      counters.offeredPackets++;
      counters.offeredBytes += size;
      if (params.lossPct && lossDraw * 100 < params.lossPct) {
        counters.lossPackets++; counters.lossBytes += size;
        if (entry) { entry.dropped = 'loss'; record(entry); }
        return;
      }
      let finish = t;
      if (params.shaped) {
        prune(t);
        if (backlogBytes + size > params.queueBytes) {
          counters.tailPackets++; counters.tailBytes += size;
          if (entry) { entry.dropped = 'tail'; entry.queueBytes = backlogBytes; record(entry); }
          return;
        }
        finish = serialize(Math.max(t, busyUntil), size * 8);
        busyUntil = finish;
        backlog.push({ finish, size });
        backlogBytes += size;
        maxQueueBytes = Math.max(maxQueueBytes, backlogBytes);
        maxQueuePackets = Math.max(maxQueuePackets, backlog.length - backlogHead);
      }
      const jitter = params.jitterMs ? (jitterDraw * 2 - 1) * params.jitterMs : 0;
      // Jitter never makes a packet leave before it was serialized, nor before
      // its predecessor: one FIFO for every 5-tuple on the link.
      const due = Math.max(finish + params.delayMs + jitter, finish, lastDue);
      lastDue = due;
      if (entry) {
        Object.assign(entry, { queueBytes: backlogBytes - (params.shaped ? size : 0), finishMs: rel(finish),
          jitterMs: jitter, intendedMs: rel(due) });
        record(entry);
      }
      line.push({ due, packet, deliver, size, record: entry });
      if (due <= t && lineHead === line.length - 1 && !timer && !immediate) flush();
      else arm();
    },
    stats() {
      const t = clock();
      prune(t);
      const percentile = (p) => {
        const total = counters.deliveredPackets;
        if (!total) return null;
        const target = Math.ceil(total * p);
        let seen = 0;
        for (let i = 0; i <= BUCKETS; i++) {
          seen += lateness[i];
          if (seen >= target) return i === BUCKETS ? latenessMax : (i + 1) * BUCKET_MS;
        }
        return latenessMax;
      };
      const span = lastSend !== null && lastSend > firstSend ? lastSend - firstSend : null;
      return {
        params,
        firstPacketMs: origin === null ? null : rel(origin),
        ...counters,
        // Bytes after the first send over the first-to-last send span.
        deliveredBps: span ? Math.round((counters.deliveredBytes - firstSendSize) * 8000 / span) : null,
        lateness: { meanMs: counters.deliveredPackets ? latenessSum / counters.deliveredPackets : null,
          p50Ms: percentile(0.5), p90Ms: percentile(0.9), p99Ms: percentile(0.99), maxMs: latenessMax },
        queue: { bytes: backlogBytes, packets: backlog.length - backlogHead, maxBytes: maxQueueBytes, maxPackets: maxQueuePackets,
          inFlightPackets: line.length - lineHead },
        timeline: timeline.slice(),
        ...(records ? { packets: records.slice() } : {}),
      };
    },
    close() {
      closed = true;
      clearInterval(sampler);
      clearTimeout(timer);
      if (immediate) clearImmediate(immediate);
      timer = immediate = null;
      line.length = 0;
      lineHead = 0;
    },
  };
}

function parseUpstream(upstream) {
  if (typeof upstream === 'object' && upstream) return { host: upstream.host ?? '127.0.0.1', port: Number(upstream.port) };
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(String(upstream));
  if (!match) throw new Error(`upstream must be host:port, got ${upstream}`);
  return { host: match[1] ?? match[2], port: Number(match[3]) };
}

/**
 * UDP proxy with an independently shaped link per direction. Each client
 * address gets its own upstream socket, so the upstream sees one stable
 * 5-tuple per client and replies route back to that client. Both directions
 * are FIFO links shared by all clients, as a single access bottleneck is.
 */
export async function createShaper({ listen = 0, listenHost = '127.0.0.1', upstream, down = {}, up = {}, seed = 1,
  recordPackets = false, statsFile, socketBufferBytes = 4 * 1024 * 1024, spinMs } = {}) {
  const target = parseUpstream(upstream);
  if (!Number.isInteger(target.port) || target.port <= 0 || target.port > 65535) throw new Error(`Invalid upstream port: ${target.port}`);
  const family = target.host.includes(':') ? 'udp6' : 'udp4';
  const linkOptions = { recordPackets, ...(spinMs !== undefined ? { spinMs } : {}) };
  const releases = [];
  let retiring = false;
  let releasing;
  const ownSocket = socket => {
    releases.push(() => new Promise((resolve, reject) => {
      try { socket.close(resolve); }
      catch (error) {
        if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve();
        else reject(error);
      }
    }));
    return socket;
  };
  const releaseResources = () => {
    retiring = true;
    releasing ??= (async () => {
      const results = await Promise.allSettled(releases.splice(0).map(release => Promise.resolve().then(release)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Net shaper cleanup failed');
    })();
    return releasing;
  };
  const unwind = async error => {
    try { await releaseResources(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Net shaper startup and cleanup failed', { cause: error }); }
    throw error;
  };
  try {
    const downlink = createLink(down, { ...linkOptions, seed });
    releases.push(() => downlink.close());
    const uplink = createLink(up, { ...linkOptions, seed: seed + 1 });
    releases.push(() => uplink.close());
    const sessions = new Map();
    releases.push(() => sessions.clear());
    // Link times are relative to their creation, just above.
    const startedAtEpochMs = Date.now();
    const startedAt = new Date(startedAtEpochMs).toISOString();
    const tune = (socket) => {
      try { socket.setRecvBufferSize(socketBufferBytes); socket.setSendBufferSize(socketBufferBytes); } catch { /* best effort */ }
    };
    const errors = [];
    const server = ownSocket(dgram.createSocket(listenHost.includes(':') ? 'udp6' : 'udp4'));
    server.on('error', error => errors.push(error.message));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.bind(listen, listenHost, () => { server.off('error', reject); resolve(); });
    });
    tune(server);
    const toClient = (address, port) => (packet) => server.send(packet, port, address);

    server.on('message', (packet, client) => {
      if (retiring) return;
      const key = `${client.address}:${client.port}`;
      let session = sessions.get(key);
      if (!session) {
        const socket = ownSocket(dgram.createSocket(family));
        socket.on('error', error => errors.push(`${key}: ${error.message}`));
        const reply = toClient(client.address, client.port);
        socket.on('message', (back, from) => {
          if (retiring || from.port !== target.port) return;
          downlink.enqueue(back, reply);
        });
        // Sends issued while binding are queued by dgram.
        socket.bind(0, () => tune(socket));
        session = { socket, send: (bytes) => socket.send(bytes, target.port, target.host) };
        sessions.set(key, session);
      }
      uplink.enqueue(packet, session.send);
    });

    const stats = () => ({ startedAt, startedAtEpochMs, listen: { host: listenHost, port: server.address().port }, upstream: target,
      seed, clients: sessions.size, errors: errors.slice(), down: downlink.stats(), up: uplink.stats() });
    let closing;
    return {
      port: server.address().port,
      stats,
      close() {
        closing ??= (async () => {
          let final;
          try { final = stats(); }
          catch (error) { return unwind(error); }
          await releaseResources();
          if (statsFile) await writeFile(statsFile, `${JSON.stringify(final, null, 2)}\n`);
          return final;
        })();
        return closing;
      },
    };
  } catch (error) { return unwind(error); }
}
