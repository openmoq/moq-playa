/**
 * Deterministic MoQT scenario runner (testkit).
 *
 * Drives a real CLIENT+SERVER loopback pair through a seeded sequence of
 * operations, maintaining a shadow model and asserting protocol/session
 * invariants after every step and at quiescence. It throws on the first invariant
 * violation (with the op log) — it does NOT use the test framework, so it can live
 * in the testkit and ship-free.
 *
 * **Version-parameterized** (like LibMoQ's profile-parameterized scenarios):
 * `runScenario({ version })` defaults to draft-18, but the op set + invariants are
 * version-agnostic except where gated on topology (the control-stream-leakage
 * invariant is draft-18-only).
 *
 * **Op set:** every version runs the subscriber lifecycle (SUBSCRIBE / ACCEPT /
 * REJECT / SEND / UNSUBSCRIBE / QUIESCE). draft-18 additionally runs the FETCH,
 * outbound-PUBLISH, and continuing-stream (SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS)
 * families. Under a valid schedule there must be zero `onError` and no unexpected
 * close. Schedules are clean by default; an optional deterministic transport-fault
 * config ({@link ScenarioOptions.faults}, e.g. 1-byte chunking) stresses the
 * framing/partial-read paths without changing the op set or invariants.
 *
 * @module
 */
import { SessionState, SubscriptionState, FetchState, NamespaceState, varint } from '@moqt/transport';
import type { MoqtObject, DraftVersion, DataStreamHeader, ControlMessage } from '@moqt/transport';
import { connectedPair, ns, nm, type ConnectedPair } from './pair.js';
import { flush, type PipeFaults } from './loopback.js';
import { makePrng } from './prng.js';
import { fnv1a64, type TraceRecord } from './trace-hash.js';
import type { TrackSubscription } from '../adapter.js';

/** Stable op codes (folded into the trace hash). */
export const Op = {
  SUBSCRIBE: 1, ACCEPT: 2, REJECT: 3, SEND: 4, UNSUBSCRIBE: 5, QUIESCE: 6,
  // ── FETCH family (draft-18 only in this slice) ──
  FETCH: 7, ACCEPT_FETCH: 8, REJECT_FETCH: 9, OPEN_FETCH_STREAM: 10,
  SEND_FETCH_OBJECT: 11, SEND_FETCH_EOR: 12, CANCEL_FETCH: 13,
  // ── outbound PUBLISH family (draft-18 only in this slice) ──
  PUBLISH: 14, ACCEPT_PUBLISH: 15, REJECT_PUBLISH: 16, SEND_PUBLISH_OBJECT: 17, PUBLISH_DONE: 18,
  // ── continuing streams: SUBSCRIBE_NAMESPACE family (draft-18 only) ──
  SUBSCRIBE_NAMESPACE: 19, ACCEPT_NAMESPACE: 20, REJECT_NAMESPACE: 21,
  SEND_NAMESPACE: 22, SEND_NAMESPACE_DONE: 23, CANCEL_NAMESPACE: 24,
  // ── continuing streams: SUBSCRIBE_TRACKS family (draft-18 only) ──
  SUBSCRIBE_TRACKS: 25, ACCEPT_TRACKS: 26, REJECT_TRACKS: 27, SEND_PUBLISH_BLOCKED: 28, CANCEL_TRACKS: 29,
} as const;

/** Subscriber-lifecycle op set — runs on every version. */
const SUBSCRIBE_OPS = [Op.SUBSCRIBE, Op.ACCEPT, Op.REJECT, Op.SEND, Op.UNSUBSCRIBE, Op.QUIESCE];
/** FETCH op set — added only for draft-18 (legacy FETCH scenarios are a later slice). */
const FETCH_OPS = [Op.FETCH, Op.ACCEPT_FETCH, Op.REJECT_FETCH, Op.OPEN_FETCH_STREAM, Op.SEND_FETCH_OBJECT, Op.SEND_FETCH_EOR, Op.CANCEL_FETCH];
/** Outbound PUBLISH op set — added only for draft-18 (legacy PUBLISH is a later slice). */
const PUBLISH_OPS = [Op.PUBLISH, Op.ACCEPT_PUBLISH, Op.REJECT_PUBLISH, Op.SEND_PUBLISH_OBJECT, Op.PUBLISH_DONE];
/** Continuing-stream op set (SUBSCRIBE_NAMESPACE + SUBSCRIBE_TRACKS) — draft-18 only. */
const CONTINUING_OPS = [
  Op.SUBSCRIBE_NAMESPACE, Op.ACCEPT_NAMESPACE, Op.REJECT_NAMESPACE, Op.SEND_NAMESPACE, Op.SEND_NAMESPACE_DONE, Op.CANCEL_NAMESPACE,
  Op.SUBSCRIBE_TRACKS, Op.ACCEPT_TRACKS, Op.REJECT_TRACKS, Op.SEND_PUBLISH_BLOCKED, Op.CANCEL_TRACKS,
];

/** Stringify a namespace tuple (suffix/prefix) for shadow-set keys. */
const sufKey = (tuple: readonly Uint8Array[]): string => tuple.map((f) => new TextDecoder().decode(f)).join('/');

// FETCH objects use a group space disjoint from subscribe `SEND` (which starts at
// group 0 and grows slowly), so a fetch object can never be mistaken for — or leak
// into — a subscription's delivery set (the subset invariant would catch it).
const FETCH_DATA_GROUP = 7000n;
const FETCH_GAP_GROUP = 8000n;
// Outbound-publish track aliases live in a range disjoint from subscription
// aliases (which start at 1) so the two alias spaces can never collide.
const PUBLISH_ALIAS_BASE = 500000n;

/** Shadow state for one subscription, keyed by its (client even) Request ID. */
interface SubShadow {
  readonly reqId: bigint;
  readonly namespace: Uint8Array[];
  readonly name: Uint8Array;
  state: 'pending' | 'active' | 'rejected' | 'unsubscribed';
  alias?: bigint;
  /** `group:object` keys sent by the publisher on this subscription. */
  readonly sent: Set<string>;
  /** `group:object` keys delivered to this subscription's onObject. */
  readonly delivered: Set<string>;
  handle?: TrackSubscription;
  /** Set once the subscribeTrack promise settles (accept → ok, reject → !ok). */
  resolved?: { ok: boolean };
}

/** Shadow state for one outgoing FETCH, keyed by its (client even) Request ID. */
interface FetchShadow {
  readonly reqId: bigint;
  readonly groupOrder: 'ascending' | 'descending';
  state: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'completed';
  /** Server-side fetch data stream id, once OPEN_FETCH_STREAM ran. */
  serverStreamId?: bigint;
  /** Next Object ID to publish on the single fetch data group (ascending). */
  nextObjectId: bigint;
  /** `data:group:object` / `gap:group:object` keys the publisher sent. */
  readonly sent: Set<string>;
  /** Keys delivered to the connection-level onObject (the fetch path, not aliases). */
  readonly delivered: Set<string>;
}

/** Shadow state for one OUTBOUND PUBLISH (client is the publisher), keyed by Request ID. */
interface PublishShadow {
  readonly reqId: bigint;
  /** Publisher-chosen Track Alias (disjoint from subscription aliases). */
  readonly alias: bigint;
  state: 'pending' | 'accepted' | 'rejected' | 'done' | 'cancelled';
  /** Next subgroup group to publish. */
  nextGroup: bigint;
  /** `group:object` keys the publisher sent. */
  readonly sent: Set<string>;
  /** Keys delivered to the PEER's IncomingPublish.onObject (not generic onObject). */
  readonly delivered: Set<string>;
}

/** Shadow for one SUBSCRIBE_NAMESPACE continuing stream (client is the subscriber). */
interface NamespaceShadow {
  readonly reqId: bigint;
  readonly prefix: Uint8Array[];
  state: 'pending' | 'active' | 'rejected' | 'cancelled' | 'done';
  nextSuffix: number;
  /** Suffix keys the peer announced (NAMESPACE) / withdrew (NAMESPACE_DONE). */
  readonly announced: Set<string>;
  readonly doneSuffixes: Set<string>;
  /** Suffix keys the subscriber received via onNamespaceMessage. */
  readonly recvAnnounced: Set<string>;
  readonly recvDone: Set<string>;
}

/** Shadow for one SUBSCRIBE_TRACKS continuing stream (client is the subscriber). */
interface TracksShadow {
  readonly reqId: bigint;
  readonly prefix: Uint8Array[];
  state: 'pending' | 'active' | 'rejected' | 'cancelled';
  nextBlocked: number;
  /** `suffix|trackName` keys the peer reported (PUBLISH_BLOCKED) / the subscriber received. */
  readonly blockedSent: Set<string>;
  readonly blockedRecv: Set<string>;
}

export interface ScenarioResult {
  readonly hash: bigint;
  readonly log: readonly TraceRecord[];
}

export interface ScenarioOptions {
  readonly seed: bigint;
  readonly steps: number;
  /**
   * Negotiated draft version (default 18 — the current at-risk surface). The op
   * set + invariants are version-agnostic EXCEPT the "no control-stream leakage"
   * invariant, which only applies to draft-18's uni-pair topology (draft-14/16
   * legitimately carry requests on the bidi control stream).
   */
  readonly version?: DraftVersion;
  /**
   * Optional deterministic transport faults applied to BOTH endpoints' stream
   * pipes (e.g. `{ a: { chunkSize: 1 }, b: { chunkSize: 1 } }` to deliver every
   * write one byte at a time). The op set + invariants are unchanged; this only
   * stresses the framing/partial-read paths. Semantically-transparent faults
   * (chunking) keep the trace hash identical to an unfaulted run of the same seed.
   */
  readonly faults?: { a?: PipeFaults; b?: PipeFaults };
}

function check(cond: boolean, msg: string, log: TraceRecord[]): void {
  if (!cond) {
    const tail = log.slice(-12).map((r) => `#${r.step} op${r.op} rid${r.requestId}`).join(' | ');
    throw new Error(`scenario invariant failed: ${msg}\n  recent ops: ${tail}`);
  }
}

const objKey = (o: MoqtObject): string => `${o.groupId}:${o.objectId}`;

/** Flush the microtask queue until `pred()` holds (bounded). */
async function flushUntil(pred: () => boolean, max = 200): Promise<void> {
  for (let i = 0; i < max && !pred(); i++) await flush();
}

/** Total written bytes + open-stream counts across both transports (a quiescence signal). */
function transportSignature(p: ConnectedPair): number {
  let bytes = 0, streams = 0;
  for (const t of [p.a, p.b]) {
    for (const u of t.uniOut) { bytes += u.writtenBytes().length; streams++; }
    for (const s of t.bidiOut) { bytes += s.out.writtenBytes().length + s.in.writtenBytes().length; streams++; }
  }
  return bytes * 17 + streams;
}

/**
 * Flush until a quiescence signature is stable across two rounds. The default
 * signature is transport bytes/streams; callers pass a delivery-aware signature so
 * quiescence also waits for in-flight (e.g. byte-chunked) data to be DELIVERED, not
 * just written — under transport faults, writes complete long before reads.
 */
async function quiesce(p: ConnectedPair, signature?: () => number): Promise<void> {
  const sig = signature ?? (() => transportSignature(p));
  let prev = -1, stable = 0;
  for (let i = 0; i < 200; i++) {
    await flush();
    const s = sig();
    if (s === prev) { if (++stable >= 2) return; } else { stable = 0; prev = s; }
  }
}

/**
 * Run one deterministic scenario and return its trace hash + log. Throws on the
 * first invariant violation.
 */
export async function runScenario(opts: ScenarioOptions): Promise<ScenarioResult> {
  const version = opts.version ?? 18;
  const pair = await connectedPair(version, opts.faults ? { faults: opts.faults } : {});
  const { client, server, a, b, errors } = pair;
  const prng = makePrng(opts.seed);
  const log: TraceRecord[] = [];

  // draft-18 only: control rides the uni pair ONLY for SETUP, so capture the
  // post-SETUP lengths — any later byte on the control stream is a leak. (For
  // draft-14/16 the control stream legitimately carries requests, so this
  // invariant does not apply.)
  const isUniPair = version === 18;
  const setupLenA = isUniPair ? a.uniOut[0]!.writtenBytes().length : 0;
  const setupLenB = isUniPair ? b.uniOut[0]!.writtenBytes().length : 0;

  const subs = new Map<bigint, SubShadow>();
  const seenInbound = new Set<bigint>();
  server.onSubscribe = (rid) => { seenInbound.add(rid); };

  // FETCH state (draft-18). Fetch data is delivered via the connection-level
  // onObject (NO alias routing), correlated to its Request ID through the
  // FETCH_HEADER seen on onDataStream — proving fetch delivery is separate from
  // alias-based subscription delivery.
  const fetches = new Map<bigint, FetchShadow>();
  const seenFetch = new Set<bigint>();
  server.onFetch = (rid) => { seenFetch.add(rid); };
  const fetchStreamToReq = new Map<bigint, bigint>(); // client data stream id → fetch reqId
  client.onDataStream = (sid: bigint, header: DataStreamHeader) => {
    if (header.type === 'fetch') fetchStreamToReq.set(sid, header.header.requestId as bigint);
  };
  client.onObject = (sid: bigint, obj: MoqtObject) => {
    const rid = fetchStreamToReq.get(sid);
    if (rid === undefined) return; // not a fetch stream — ignore (e.g. late data on a freed alias)
    const f = fetches.get(rid);
    if (!f) return;
    f.delivered.add(obj.kind === 'gap' ? `gap:${obj.groupId}:${obj.objectId}` : `data:${obj.groupId}:${obj.objectId}`);
  };

  // Outbound PUBLISH state (draft-18). The client is the publisher; the SERVER is
  // the peer and receives published objects via IncomingPublish.onObject (alias
  // routing), NEVER its generic onObject — `serverGenericObjects` is a leak detector
  // that must stay empty (the server never legitimately receives data otherwise).
  const publishes = new Map<bigint, PublishShadow>();
  const seenPublish = new Set<bigint>();
  const serverGenericObjects: MoqtObject[] = [];
  server.onObject = (_sid: bigint, obj: MoqtObject) => { serverGenericObjects.push(obj); };
  server.onPublish = (p) => {
    seenPublish.add(p.requestId);
    p.onObject = (o: MoqtObject) => {
      const pub = publishes.get(p.requestId);
      if (pub && o.kind === 'data') pub.delivered.add(`${o.groupId}:${o.objectId}`);
    };
  };
  let nextPublishAlias = PUBLISH_ALIAS_BASE;

  // Continuing streams (draft-18): the client subscribes to namespace prefixes
  // (SUBSCRIBE_NAMESPACE) and track prefixes (SUBSCRIBE_TRACKS); the SERVER is the
  // peer that accepts and emits continuation messages (NAMESPACE / NAMESPACE_DONE,
  // PUBLISH_BLOCKED) on the SAME continuing request stream. Continuation messages
  // are routed to the matching request by Request ID (onNamespaceMessage /
  // onPublishBlocked carry the rid).
  const namespaceSubs = new Map<bigint, NamespaceShadow>();
  const trackSubs = new Map<bigint, TracksShadow>();
  const seenNamespace = new Set<bigint>();
  const seenTracks = new Set<bigint>();
  server.onSubscribeNamespace = (rid) => { seenNamespace.add(rid); };
  server.onSubscribeTracks = (rid) => { seenTracks.add(rid); };
  client.onNamespaceMessage = (rid: bigint, msg: ControlMessage) => {
    const n = namespaceSubs.get(rid);
    if (!n) return;
    const m = msg as { type: string; trackNamespaceSuffix?: Uint8Array[] };
    const key = sufKey(m.trackNamespaceSuffix ?? []);
    if (m.type === 'NAMESPACE') n.recvAnnounced.add(key);
    else if (m.type === 'NAMESPACE_DONE') n.recvDone.add(key);
  };
  client.onPublishBlocked = (rid: bigint, msg: ControlMessage) => {
    const t = trackSubs.get(rid);
    if (!t) return;
    const m = msg as { trackNamespaceSuffix?: Uint8Array[]; trackName?: Uint8Array };
    t.blockedRecv.add(`${sufKey(m.trackNamespaceSuffix ?? [])}|${new TextDecoder().decode(m.trackName ?? new Uint8Array())}`);
  };

  // Single monotonic client request-id counter — SUBSCRIBE, FETCH, PUBLISH,
  // SUBSCRIBE_NAMESPACE and SUBSCRIBE_TRACKS all share it (request IDs are one
  // per-direction sequence), so the shadow predicts all.
  let clientReqCount = 0;
  let nextAlias = 1n;
  let nextGroup = 0n;
  let step = 0;

  const rec = (op: number, side: number, x: Partial<TraceRecord> = {}): void => {
    log.push({ step, op, side, requestId: x.requestId ?? 0n, alias: x.alias ?? 0n, group: x.group ?? 0n, outcome: x.outcome ?? 0 });
  };
  const pending = () => [...subs.values()].filter((s) => s.state === 'pending');
  const active = () => [...subs.values()].filter((s) => s.state === 'active');
  // Cumulative sent/delivered totals — folded into QUIESCE trace records so the
  // determinism hash reflects actual protocol DELIVERY, not just op selection
  // (a divergence in routing/delivery changes the hash).
  const totals = () => {
    let sent = 0n, delivered = 0n;
    for (const s of subs.values()) { sent += BigInt(s.sent.size); delivered += BigInt(s.delivered.size); }
    for (const f of fetches.values()) { sent += BigInt(f.sent.size); delivered += BigInt(f.delivered.size); }
    for (const p of publishes.values()) { sent += BigInt(p.sent.size); delivered += BigInt(p.delivered.size); }
    for (const n of namespaceSubs.values()) { sent += BigInt(n.announced.size + n.doneSuffixes.size); delivered += BigInt(n.recvAnnounced.size + n.recvDone.size); }
    for (const t of trackSubs.values()) { sent += BigInt(t.blockedSent.size); delivered += BigInt(t.blockedRecv.size); }
    return { sent, delivered };
  };
  const recQuiesce = (): void => { const t = totals(); rec(Op.QUIESCE, 0, { alias: t.sent, group: t.delivered, outcome: 1 }); };
  // Quiescence must wait for DELIVERY too (a faulted/chunked transport finishes
  // writing long before the peer finishes reading), so fold the delivered total
  // into the signature alongside the transport's written-bytes signature.
  const deliverySig = (): number => transportSignature(pair) * 1009 + Number(totals().delivered);

  function assertInvariants(quiesced: boolean): void {
    // No onError and no unexpected close on a valid schedule.
    check(errors.length === 0, `unexpected onError: ${errors[0]?.message}`, log);
    check(client.session.state === SessionState.ESTABLISHED, 'client session not ESTABLISHED', log);
    check(server.session.state === SessionState.ESTABLISHED, 'server session not ESTABLISHED', log);
    // draft-18: no post-SETUP control-stream leakage (requests ride bidi/uni-pair).
    if (isUniPair) {
      check(a.uniOut[0]!.writtenBytes().length === setupLenA, 'client uni-control bytes leaked post-SETUP', log);
      check(b.uniOut[0]!.writtenBytes().length === setupLenB, 'server uni-control bytes leaked post-SETUP', log);
    }

    const aliasesInUse = new Set<bigint>();
    for (const s of subs.values()) {
      check(s.reqId % 2n === 0n, `client request id ${s.reqId} is not even`, log); // client parity
      if (s.state === 'active') {
        const cs = client.session.getSubscription(s.reqId);
        const ss = server.session.getIncomingSubscription(s.reqId);
        check(cs !== undefined, `active sub ${s.reqId} missing on client`, log);
        check(cs!.state === SubscriptionState.ESTABLISHED, `active sub ${s.reqId} not ESTABLISHED on client`, log);
        check(ss !== undefined, `active sub ${s.reqId} missing on server`, log);
        // SUBSCRIBE_OK correlated to the right stream → alias bound to the intended sub.
        check(cs!.trackAlias === s.alias, `sub ${s.reqId} alias ${cs!.trackAlias} != intended ${s.alias}`, log);
        check(!aliasesInUse.has(s.alias!), `alias ${s.alias} bound to two subscriptions`, log);
        aliasesInUse.add(s.alias!);
        // Delivered objects are always a subset of sent; exact once quiesced.
        for (const k of s.delivered) check(s.sent.has(k), `sub ${s.reqId} delivered un-sent object ${k}`, log);
        if (quiesced) {
          check(s.delivered.size === s.sent.size, `sub ${s.reqId} delivered ${s.delivered.size} != sent ${s.sent.size}`, log);
        }
      } else {
        // A terminated subscription (rejected or unsubscribed) must not remain
        // ACTIVE. It may be removed entirely or linger as a TERMINATED tombstone
        // — both are "not dangling"; what matters is it is not ESTABLISHED.
        const cs = client.session.getSubscription(s.reqId);
        check(cs === undefined || cs.state !== SubscriptionState.ESTABLISHED,
          `terminated sub ${s.reqId} is still ESTABLISHED on client`, log);
        // After UNSUBSCRIBE the alias is unregistered (no live routing) — all
        // versions. (Rejected subs never bound an alias.)
        if (s.state === 'unsubscribed' && s.alias !== undefined) {
          check(client.session.getTrackByAlias(s.alias) === undefined,
            `unsubscribed alias ${s.alias} is still registered on client`, log);
        }
      }
    }

    // ── FETCH invariants ──
    for (const f of fetches.values()) {
      check(f.reqId % 2n === 0n, `fetch request id ${f.reqId} is not even`, log); // client parity
      // Delivered fetch objects/gaps are always a subset of what was sent
      // (this also guards against fetch data leaking into a subscription: a leaked
      // object would land in a sub's delivered set as an un-sent key, OR be missing
      // here — both fail). Exact equality once quiesced for live fetches.
      for (const k of f.delivered) check(f.sent.has(k), `fetch ${f.reqId} delivered un-sent ${k}`, log);
      if (f.state === 'accepted' || f.state === 'completed') {
        if (quiesced) {
          check(f.delivered.size === f.sent.size, `fetch ${f.reqId} delivered ${f.delivered.size} != sent ${f.sent.size}`, log);
        }
      } else if (f.state === 'rejected') {
        // A REQUEST_ERROR-rejected fetch must be gone or COMPLETED — never left
        // stuck in PENDING/TRANSFERRING — and must have delivered nothing.
        const cf = client.session.getFetch(f.reqId);
        check(cf === undefined || cf.state === FetchState.COMPLETED, `rejected fetch ${f.reqId} not COMPLETED/removed (state ${cf?.state})`, log);
        check(f.delivered.size === 0, `rejected fetch ${f.reqId} delivered ${f.delivered.size} objects`, log);
      } else if (f.state === 'cancelled') {
        // A cancelled fetch is torn down (no longer TRANSFERRING) and delivers no
        // MORE than was sent — late data after cancel must not arrive (subset, not
        // exact: cancel may interrupt delivery).
        const cf = client.session.getFetch(f.reqId);
        check(cf === undefined || cf.state !== FetchState.TRANSFERRING, `cancelled fetch ${f.reqId} still transferring`, log);
        check(f.delivered.size <= f.sent.size, `cancelled fetch ${f.reqId} delivered ${f.delivered.size} > sent ${f.sent.size}`, log);
      }
      // 'pending' / 'accepted'-mid-step: only the subset rule applies.
    }

    // ── outbound PUBLISH invariants ──
    const pubAliases = new Set<bigint>();
    for (const p of publishes.values()) {
      check(p.reqId % 2n === 0n, `publish request id ${p.reqId} is not even`, log); // client parity
      check(!pubAliases.has(p.alias), `publish alias ${p.alias} reused across publishes`, log);
      pubAliases.add(p.alias);
      check(!aliasesInUse.has(p.alias), `publish alias ${p.alias} collides with a subscription alias`, log);
      // Delivered ⊆ sent — and because published objects route ONLY to the peer's
      // IncomingPublish.onObject (asserted via serverGenericObjects below), a leak
      // to a wrong alias would surface as a missing/extra key here.
      for (const k of p.delivered) check(p.sent.has(k), `publish ${p.reqId} delivered un-sent ${k}`, log);
      if (p.state === 'accepted' || p.state === 'done') {
        const op = client.session.getOutgoingPublish(p.reqId);
        if (p.state === 'accepted') {
          check(op?.state === SubscriptionState.ESTABLISHED, `accepted publish ${p.reqId} not ESTABLISHED on publisher (state ${op?.state})`, log);
        } else {
          // PUBLISH_DONE removes the publisher's outgoing state (§10.11).
          check(op === undefined, `done publish ${p.reqId} still tracked on publisher (state ${op?.state})`, log);
        }
        if (quiesced) {
          check(p.delivered.size === p.sent.size, `publish ${p.reqId} delivered ${p.delivered.size} != sent ${p.sent.size}`, log);
        }
      } else if (p.state === 'rejected') {
        check(client.session.getOutgoingPublish(p.reqId) === undefined, `rejected publish ${p.reqId} still tracked on publisher`, log);
        check(p.delivered.size === 0, `rejected publish ${p.reqId} delivered ${p.delivered.size} objects`, log);
      }
    }
    // Published objects MUST route to the peer's IncomingPublish.onObject, never the
    // generic onObject (and never an unrelated alias).
    check(serverGenericObjects.length === 0, `published object leaked to the peer's generic onObject (${serverGenericObjects.length})`, log);

    // ── SUBSCRIBE_NAMESPACE invariants ──
    for (const n of namespaceSubs.values()) {
      check(n.reqId % 2n === 0n, `namespace request id ${n.reqId} is not even`, log);
      // NAMESPACE / NAMESPACE_DONE reach ONLY the matching subscription (routed by
      // Request ID) — a misroute would surface as an un-announced received key here.
      for (const k of n.recvAnnounced) check(n.announced.has(k), `namespace ${n.reqId} received un-announced NAMESPACE ${k}`, log);
      for (const k of n.recvDone) check(n.doneSuffixes.has(k), `namespace ${n.reqId} received un-sent NAMESPACE_DONE ${k}`, log);
      if (n.state === 'active') {
        const cs = client.session.getNamespaceSubscription(n.reqId);
        check(cs?.state === NamespaceState.ACTIVE, `active namespace ${n.reqId} not ACTIVE on client (state ${cs?.state})`, log);
        if (quiesced) {
          check(n.recvAnnounced.size === n.announced.size, `namespace ${n.reqId} announced delivered ${n.recvAnnounced.size} != sent ${n.announced.size}`, log);
          check(n.recvDone.size === n.doneSuffixes.size, `namespace ${n.reqId} NAMESPACE_DONE delivered ${n.recvDone.size} != sent ${n.doneSuffixes.size}`, log);
        }
      } else if (n.state === 'done') {
        // §6.1: NAMESPACE_DONE terminated the subscription. All prior NAMESPACE and
        // the terminating NAMESPACE_DONE were delivered; the client sub is gone/TERMINATED.
        const cs = client.session.getNamespaceSubscription(n.reqId);
        check(cs === undefined || cs.state === NamespaceState.TERMINATED, `done namespace ${n.reqId} not TERMINATED/removed (state ${cs?.state})`, log);
        if (quiesced) {
          check(n.recvAnnounced.size === n.announced.size, `namespace ${n.reqId} announced delivered ${n.recvAnnounced.size} != sent ${n.announced.size}`, log);
          check(n.recvDone.size === n.doneSuffixes.size, `namespace ${n.reqId} NAMESPACE_DONE delivered ${n.recvDone.size} != sent ${n.doneSuffixes.size}`, log);
        }
      } else if (n.state === 'rejected') {
        const cs = client.session.getNamespaceSubscription(n.reqId);
        check(cs === undefined || cs.state !== NamespaceState.ACTIVE, `rejected namespace ${n.reqId} still ACTIVE`, log);
        check(n.recvAnnounced.size === 0 && n.recvDone.size === 0, `rejected namespace ${n.reqId} received continuation`, log);
      } else if (n.state === 'cancelled') {
        // CANCEL_NAMESPACE closed the continuing stream — the client sub is gone or
        // TERMINATED, and no NEW continuation arrives (the subset rule above bounds
        // any in-flight NAMESPACE that raced the cancel).
        const cs = client.session.getNamespaceSubscription(n.reqId);
        check(cs === undefined || cs.state === NamespaceState.TERMINATED, `cancelled namespace ${n.reqId} not TERMINATED/removed (state ${cs?.state})`, log);
      }
      // 'pending': only the subset rule above applies.
    }

    // ── SUBSCRIBE_TRACKS invariants ──
    for (const t of trackSubs.values()) {
      check(t.reqId % 2n === 0n, `tracks request id ${t.reqId} is not even`, log);
      for (const k of t.blockedRecv) check(t.blockedSent.has(k), `tracks ${t.reqId} received un-sent PUBLISH_BLOCKED ${k}`, log);
      if (t.state === 'active') {
        const cs = client.session.getTrackSubscription(t.reqId);
        check(cs?.state === 'active', `active tracks ${t.reqId} not active on client (state ${cs?.state})`, log);
        if (quiesced) {
          check(t.blockedRecv.size === t.blockedSent.size, `tracks ${t.reqId} PUBLISH_BLOCKED delivered ${t.blockedRecv.size} != sent ${t.blockedSent.size}`, log);
        }
      } else if (t.state === 'rejected') {
        const cs = client.session.getTrackSubscription(t.reqId);
        check(cs === undefined || cs.state === 'terminated', `rejected tracks ${t.reqId} not terminated/removed (state ${cs?.state})`, log);
        check(t.blockedRecv.size === 0, `rejected tracks ${t.reqId} received PUBLISH_BLOCKED`, log);
      } else if (t.state === 'cancelled') {
        // CANCEL_TRACKS closed the continuing stream — the client sub is gone or
        // 'terminated'; the subset rule above bounds any in-flight PUBLISH_BLOCKED.
        const cs = client.session.getTrackSubscription(t.reqId);
        check(cs === undefined || cs.state === 'terminated', `cancelled tracks ${t.reqId} not terminated/removed (state ${cs?.state})`, log);
      }
    }

    // Request IDs are globally unique across every request family.
    const allReqIds = [...subs.keys(), ...fetches.keys(), ...publishes.keys(), ...namespaceSubs.keys(), ...trackSubs.keys()];
    check(new Set(allReqIds).size === allReqIds.length, 'duplicate request id across request families', log);
  }

  // ── operation handlers ──────────────────────────────────────────────────
  async function opSubscribe(): Promise<void> {
    const reqId = BigInt(2 * clientReqCount); // client even, +2 — matches the allocator
    clientReqCount++;
    const namespace = ns(`t${reqId}`);
    const name = nm(`v${reqId}`);
    const sub: SubShadow = { reqId, namespace, name, state: 'pending', sent: new Set(), delivered: new Set() };
    const p = client.subscribeTrack(namespace, name, {
      onObject: (o) => { if (o.kind === 'data') sub.delivered.add(objKey(o)); },
    });
    void p.then((h) => { sub.handle = h; sub.resolved = { ok: true }; }, () => { sub.resolved = { ok: false }; });
    subs.set(reqId, sub);
    // Open the request stream and wait until the server observes the SUBSCRIBE.
    // flushUntil (not a single flush) so a byte-chunked transport still converges.
    await flushUntil(() => seenInbound.has(reqId));
    check(seenInbound.has(reqId), `server did not observe SUBSCRIBE ${reqId}`, log);
    rec(Op.SUBSCRIBE, 0, { requestId: reqId, outcome: 1 });
  }

  async function opAccept(): Promise<void> {
    const cands = pending();
    if (cands.length === 0) { rec(Op.ACCEPT, 1, { outcome: 0 }); return; }
    const sub = prng.pick(cands);
    const alias = nextAlias++;
    await server.acceptSubscribe(sub.reqId, alias);
    await flushUntil(() => sub.resolved !== undefined);
    check(sub.resolved?.ok === true, `accept ${sub.reqId} did not resolve the subscription`, log);
    sub.state = 'active'; sub.alias = alias;
    rec(Op.ACCEPT, 1, { requestId: sub.reqId, alias, outcome: 1 });
  }

  async function opReject(): Promise<void> {
    const cands = pending();
    if (cands.length === 0) { rec(Op.REJECT, 1, { outcome: 0 }); return; }
    const sub = prng.pick(cands);
    await server.rejectSubscribe(sub.reqId, 1n, 'scenario reject');
    await flushUntil(() => sub.resolved !== undefined);
    check(sub.resolved?.ok === false, `reject ${sub.reqId} unexpectedly resolved`, log);
    sub.state = 'rejected';
    rec(Op.REJECT, 1, { requestId: sub.reqId, outcome: 2 });
  }

  async function opSend(): Promise<void> {
    const cands = active();
    if (cands.length === 0) { rec(Op.SEND, 1, { outcome: 0 }); return; }
    const sub = prng.pick(cands);
    const group = nextGroup++;
    const payload = new Uint8Array([Number(group & 0xffn), 0xa5]);
    const sid = await server.openSubgroup(sub.alias!, group, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, payload);
    await server.closeSubgroup(sid);
    sub.sent.add(`${group}:0`);
    await flush();
    rec(Op.SEND, 1, { requestId: sub.reqId, alias: sub.alias, group, outcome: 1 });
  }

  async function opUnsubscribe(): Promise<void> {
    const cands = active();
    if (cands.length === 0) { rec(Op.UNSUBSCRIBE, 0, { outcome: 0 }); return; }
    const sub = prng.pick(cands);
    // The TrackSubscription handle routes through adapter.unsubscribe(), which is
    // version-aware (draft-18 resets the request stream; draft-14/16 send
    // UNSUBSCRIBE) and also drops the alias routing entry.
    await sub.handle!.unsubscribe();
    await flush();
    sub.state = 'unsubscribed';
    rec(Op.UNSUBSCRIBE, 0, { requestId: sub.reqId, alias: sub.alias, outcome: 1 });
  }

  // ── FETCH operation handlers (draft-18) ──────────────────────────────────
  const pendingFetches = () => [...fetches.values()].filter((f) => f.state === 'pending');
  const streamingFetches = () => [...fetches.values()].filter((f) => f.state === 'accepted' && f.serverStreamId !== undefined);

  async function opFetch(): Promise<void> {
    const reqId = BigInt(2 * clientReqCount); // shares the client request-id sequence
    clientReqCount++;
    const groupOrder = prng.pick(['ascending', 'descending'] as const);
    const f: FetchShadow = { reqId, groupOrder, state: 'pending', nextObjectId: 0n, sent: new Set(), delivered: new Set() };
    // fetch() resolves with the assigned Request ID once the FETCH is SENT.
    const actualId = await client.fetch(ns(`f${reqId}`), nm(`fv${reqId}`), {
      startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n, groupOrder,
    });
    check(actualId === reqId, `fetch reqId ${actualId} != predicted ${reqId}`, log);
    fetches.set(reqId, f);
    await flushUntil(() => seenFetch.has(reqId));
    check(seenFetch.has(reqId), `server did not observe FETCH ${reqId}`, log);
    rec(Op.FETCH, 0, { requestId: reqId, outcome: 1 });
  }

  async function opAcceptFetch(): Promise<void> {
    const cands = pendingFetches();
    if (cands.length === 0) { rec(Op.ACCEPT_FETCH, 1, { outcome: 0 }); return; }
    const f = prng.pick(cands);
    await server.acceptFetch(f.reqId); // FETCH_OK on the same bidi request stream
    await flushUntil(() => client.session.getFetch(f.reqId)?.state === FetchState.TRANSFERRING);
    check(client.session.getFetch(f.reqId)?.state === FetchState.TRANSFERRING, `accept fetch ${f.reqId} did not transition client to TRANSFERRING`, log);
    f.state = 'accepted';
    rec(Op.ACCEPT_FETCH, 1, { requestId: f.reqId, outcome: 1 });
  }

  async function opRejectFetch(): Promise<void> {
    const cands = pendingFetches();
    if (cands.length === 0) { rec(Op.REJECT_FETCH, 1, { outcome: 0 }); return; }
    const f = prng.pick(cands);
    await server.rejectFetch(f.reqId, 1n, 'scenario fetch reject'); // REQUEST_ERROR
    await flushUntil(() => { const cf = client.session.getFetch(f.reqId); return cf === undefined || cf.state === FetchState.COMPLETED; });
    f.state = 'rejected';
    rec(Op.REJECT_FETCH, 1, { requestId: f.reqId, outcome: 2 });
  }

  async function opOpenFetchStream(): Promise<void> {
    const cands = [...fetches.values()].filter((f) => f.state === 'accepted' && f.serverStreamId === undefined);
    if (cands.length === 0) { rec(Op.OPEN_FETCH_STREAM, 1, { outcome: 0 }); return; }
    const f = prng.pick(cands);
    f.serverStreamId = await server.openFetchStream(f.reqId); // writes FETCH_HEADER
    await flush();
    rec(Op.OPEN_FETCH_STREAM, 1, { requestId: f.reqId, outcome: 1 });
  }

  async function opSendFetchObject(): Promise<void> {
    const cands = streamingFetches();
    if (cands.length === 0) { rec(Op.SEND_FETCH_OBJECT, 1, { outcome: 0 }); return; }
    const f = prng.pick(cands);
    const objectId = f.nextObjectId++;
    // Single ascending group (disjoint from subscribe groups) — valid for any
    // requested Group Order; the adapter threads the per-stream prior.
    await server.sendFetchObject(f.serverStreamId!, {
      groupId: FETCH_DATA_GROUP, subgroupId: 0n, objectId,
      publisherPriority: 1, payload: new Uint8Array([Number(objectId & 0xffn), 0xf7]),
    });
    f.sent.add(`data:${FETCH_DATA_GROUP}:${objectId}`);
    await flush();
    rec(Op.SEND_FETCH_OBJECT, 1, { requestId: f.reqId, group: FETCH_DATA_GROUP, outcome: 1 });
  }

  async function opSendFetchEor(): Promise<void> {
    const cands = streamingFetches();
    if (cands.length === 0) { rec(Op.SEND_FETCH_EOR, 1, { outcome: 0 }); return; }
    const f = prng.pick(cands);
    // End-of-Range gap (absolute position; no group-order constraint), then FIN the
    // fetch stream — the fetch completes after delivering all data + the gap.
    await server.sendFetchEndOfRange(f.serverStreamId!, true, FETCH_GAP_GROUP, 0n);
    f.sent.add(`gap:${FETCH_GAP_GROUP}:0`);
    await server.closeFetchStream(f.serverStreamId!);
    f.state = 'completed';
    await flush();
    rec(Op.SEND_FETCH_EOR, 1, { requestId: f.reqId, group: FETCH_GAP_GROUP, outcome: 1 });
  }

  async function opCancelFetch(): Promise<void> {
    const cands = [...fetches.values()].filter((f) => f.state === 'pending' || f.state === 'accepted');
    if (cands.length === 0) { rec(Op.CANCEL_FETCH, 0, { outcome: 0 }); return; }
    const f = prng.pick(cands);
    await client.fetchCancel(f.reqId); // RESET the request stream + STOP_SENDING data
    await flush();
    f.state = 'cancelled';
    rec(Op.CANCEL_FETCH, 0, { requestId: f.reqId, outcome: 1 });
  }

  // ── outbound PUBLISH operation handlers (draft-18) ───────────────────────
  const pendingPublishes = () => [...publishes.values()].filter((p) => p.state === 'pending');
  const acceptedPublishes = () => [...publishes.values()].filter((p) => p.state === 'accepted');

  async function opPublish(): Promise<void> {
    const reqId = BigInt(2 * clientReqCount); // shares the client request-id sequence
    clientReqCount++;
    const alias = nextPublishAlias++;
    const pub: PublishShadow = { reqId, alias, state: 'pending', nextGroup: 0n, sent: new Set(), delivered: new Set() };
    const actualId = await client.publish(ns(`p${reqId}`), nm(`pv${reqId}`), alias); // resolves on send
    check(actualId === reqId, `publish reqId ${actualId} != predicted ${reqId}`, log);
    publishes.set(reqId, pub);
    await flushUntil(() => seenPublish.has(reqId));
    check(seenPublish.has(reqId), `peer did not observe PUBLISH ${reqId}`, log);
    rec(Op.PUBLISH, 0, { requestId: reqId, alias, outcome: 1 });
  }

  async function opAcceptPublish(): Promise<void> {
    const cands = pendingPublishes();
    if (cands.length === 0) { rec(Op.ACCEPT_PUBLISH, 1, { outcome: 0 }); return; }
    const pub = prng.pick(cands);
    // §10.10: the peer accepts a PUBLISH with the PUBLISH_OK shorthand (acceptSubscribe).
    await server.acceptSubscribe(pub.reqId, pub.alias);
    await flushUntil(() => client.session.getOutgoingPublish(pub.reqId)?.state === SubscriptionState.ESTABLISHED);
    check(client.session.getOutgoingPublish(pub.reqId)?.state === SubscriptionState.ESTABLISHED, `accept publish ${pub.reqId} did not establish on publisher`, log);
    pub.state = 'accepted';
    rec(Op.ACCEPT_PUBLISH, 1, { requestId: pub.reqId, alias: pub.alias, outcome: 1 });
  }

  async function opRejectPublish(): Promise<void> {
    const cands = pendingPublishes();
    if (cands.length === 0) { rec(Op.REJECT_PUBLISH, 1, { outcome: 0 }); return; }
    const pub = prng.pick(cands);
    await server.rejectSubscribe(pub.reqId, 1n, 'scenario publish reject'); // REQUEST_ERROR
    await flushUntil(() => client.session.getOutgoingPublish(pub.reqId) === undefined); // robust under chunking
    pub.state = 'rejected';
    rec(Op.REJECT_PUBLISH, 1, { requestId: pub.reqId, outcome: 2 });
  }

  async function opSendPublishObject(): Promise<void> {
    const cands = acceptedPublishes();
    if (cands.length === 0) { rec(Op.SEND_PUBLISH_OBJECT, 0, { outcome: 0 }); return; }
    const pub = prng.pick(cands);
    const group = pub.nextGroup++;
    const sid = await client.openSubgroup(pub.alias, group, 0n, { publisherPriority: 1 });
    await client.sendObject(sid, 0n, new Uint8Array([Number(group & 0xffn), 0xb9]));
    await client.closeSubgroup(sid);
    pub.sent.add(`${group}:0`);
    await flush();
    rec(Op.SEND_PUBLISH_OBJECT, 0, { requestId: pub.reqId, alias: pub.alias, group, outcome: 1 });
  }

  async function opPublishDone(): Promise<void> {
    const cands = acceptedPublishes();
    if (cands.length === 0) { rec(Op.PUBLISH_DONE, 0, { outcome: 0 }); return; }
    const pub = prng.pick(cands);
    // §10.11: end the publication. Removes the publisher's outgoing state; the
    // runner does NOT send after DONE, so it does not depend on post-DONE delivery
    // semantics (draft-18 keeps the peer's alias routing alive — see the prelude).
    await client.publishDone(pub.reqId, varint(0n), 'scenario publish done');
    await flush();
    pub.state = 'done';
    rec(Op.PUBLISH_DONE, 0, { requestId: pub.reqId, outcome: 1 });
  }

  // ── SUBSCRIBE_NAMESPACE continuing-stream handlers (draft-18) ────────────
  const pendingNamespace = () => [...namespaceSubs.values()].filter((n) => n.state === 'pending');
  const activeNamespace = () => [...namespaceSubs.values()].filter((n) => n.state === 'active');

  async function opSubscribeNamespace(): Promise<void> {
    const reqId = BigInt(2 * clientReqCount); clientReqCount++;
    const prefix = ns(`np${reqId}`); // distinct single-field prefixes never overlap (§field-wise)
    const n: NamespaceShadow = { reqId, prefix, state: 'pending', nextSuffix: 0, announced: new Set(), doneSuffixes: new Set(), recvAnnounced: new Set(), recvDone: new Set() };
    const actualId = await client.subscribeNamespace(prefix);
    check(actualId === reqId, `subscribeNamespace reqId ${actualId} != predicted ${reqId}`, log);
    namespaceSubs.set(reqId, n);
    await flushUntil(() => seenNamespace.has(reqId));
    check(seenNamespace.has(reqId), `peer did not observe SUBSCRIBE_NAMESPACE ${reqId}`, log);
    rec(Op.SUBSCRIBE_NAMESPACE, 0, { requestId: reqId, outcome: 1 });
  }

  async function opAcceptNamespace(): Promise<void> {
    const cands = pendingNamespace();
    if (cands.length === 0) { rec(Op.ACCEPT_NAMESPACE, 1, { outcome: 0 }); return; }
    const n = prng.pick(cands);
    await server.acceptSubscribeNamespace(n.reqId); // REQUEST_OK on the continuing stream
    await flushUntil(() => client.session.getNamespaceSubscription(n.reqId)?.state === NamespaceState.ACTIVE);
    check(client.session.getNamespaceSubscription(n.reqId)?.state === NamespaceState.ACTIVE, `accept namespace ${n.reqId} did not activate on subscriber`, log);
    n.state = 'active';
    rec(Op.ACCEPT_NAMESPACE, 1, { requestId: n.reqId, outcome: 1 });
  }

  async function opRejectNamespace(): Promise<void> {
    const cands = pendingNamespace();
    if (cands.length === 0) { rec(Op.REJECT_NAMESPACE, 1, { outcome: 0 }); return; }
    const n = prng.pick(cands);
    await server.rejectSubscribeNamespace(n.reqId, 1n, 'scenario namespace reject'); // REQUEST_ERROR + FIN
    await flushUntil(() => { const cs = client.session.getNamespaceSubscription(n.reqId); return cs === undefined || cs.state !== NamespaceState.ACTIVE; });
    n.state = 'rejected';
    rec(Op.REJECT_NAMESPACE, 1, { requestId: n.reqId, outcome: 2 });
  }

  async function opSendNamespace(): Promise<void> {
    const cands = activeNamespace();
    if (cands.length === 0) { rec(Op.SEND_NAMESPACE, 1, { outcome: 0 }); return; }
    const n = prng.pick(cands);
    const key = `s${n.nextSuffix++}`;
    await server.sendNamespace(n.reqId, [nm(key)]); // NAMESPACE on the same stream
    n.announced.add(key);
    await flush();
    rec(Op.SEND_NAMESPACE, 1, { requestId: n.reqId, outcome: 1 });
  }

  async function opSendNamespaceDone(): Promise<void> {
    // §6.1: NAMESPACE_DONE must name a previously-announced suffix, and it
    // TERMINATES the subscriber's namespace subscription (it is NOT a per-suffix
    // withdrawal at the subscription level — see namespace.test.ts / §6.1). So this
    // op only runs once per sub and moves it to 'done'.
    const cands = activeNamespace().filter((n) => [...n.announced].some((k) => !n.doneSuffixes.has(k)));
    if (cands.length === 0) { rec(Op.SEND_NAMESPACE_DONE, 1, { outcome: 0 }); return; }
    const n = prng.pick(cands);
    const key = [...n.announced].find((k) => !n.doneSuffixes.has(k))!; // deterministic
    await server.sendNamespaceDone(n.reqId, [nm(key)]);
    n.doneSuffixes.add(key);
    await flush();
    n.state = 'done'; // §6.1: the subscriber's namespace subscription terminates
    rec(Op.SEND_NAMESPACE_DONE, 1, { requestId: n.reqId, outcome: 1 });
  }

  async function opCancelNamespace(): Promise<void> {
    const cands = [...namespaceSubs.values()].filter((n) => n.state === 'pending' || n.state === 'active');
    if (cands.length === 0) { rec(Op.CANCEL_NAMESPACE, 0, { outcome: 0 }); return; }
    const n = prng.pick(cands);
    await client.cancelNamespace(n.reqId); // close the continuing request stream
    await flush();
    n.state = 'cancelled';
    rec(Op.CANCEL_NAMESPACE, 0, { requestId: n.reqId, outcome: 1 });
  }

  // ── SUBSCRIBE_TRACKS continuing-stream handlers (draft-18) ───────────────
  const pendingTracks = () => [...trackSubs.values()].filter((t) => t.state === 'pending');
  const activeTracks = () => [...trackSubs.values()].filter((t) => t.state === 'active');

  async function opSubscribeTracks(): Promise<void> {
    const reqId = BigInt(2 * clientReqCount); clientReqCount++;
    const prefix = ns(`nt${reqId}`);
    const t: TracksShadow = { reqId, prefix, state: 'pending', nextBlocked: 0, blockedSent: new Set(), blockedRecv: new Set() };
    const actualId = await client.subscribeTracks(prefix);
    check(actualId === reqId, `subscribeTracks reqId ${actualId} != predicted ${reqId}`, log);
    trackSubs.set(reqId, t);
    await flushUntil(() => seenTracks.has(reqId));
    check(seenTracks.has(reqId), `peer did not observe SUBSCRIBE_TRACKS ${reqId}`, log);
    rec(Op.SUBSCRIBE_TRACKS, 0, { requestId: reqId, outcome: 1 });
  }

  async function opAcceptTracks(): Promise<void> {
    const cands = pendingTracks();
    if (cands.length === 0) { rec(Op.ACCEPT_TRACKS, 1, { outcome: 0 }); return; }
    const t = prng.pick(cands);
    await server.acceptSubscribeTracks(t.reqId);
    await flushUntil(() => client.session.getTrackSubscription(t.reqId)?.state === 'active');
    check(client.session.getTrackSubscription(t.reqId)?.state === 'active', `accept tracks ${t.reqId} did not activate on subscriber`, log);
    t.state = 'active';
    rec(Op.ACCEPT_TRACKS, 1, { requestId: t.reqId, outcome: 1 });
  }

  async function opRejectTracks(): Promise<void> {
    const cands = pendingTracks();
    if (cands.length === 0) { rec(Op.REJECT_TRACKS, 1, { outcome: 0 }); return; }
    const t = prng.pick(cands);
    await server.rejectSubscribeTracks(t.reqId, 1n, 'scenario tracks reject');
    await flushUntil(() => { const cs = client.session.getTrackSubscription(t.reqId); return cs === undefined || cs.state === 'terminated'; });
    t.state = 'rejected';
    rec(Op.REJECT_TRACKS, 1, { requestId: t.reqId, outcome: 2 });
  }

  async function opSendPublishBlocked(): Promise<void> {
    const cands = activeTracks();
    if (cands.length === 0) { rec(Op.SEND_PUBLISH_BLOCKED, 1, { outcome: 0 }); return; }
    const t = prng.pick(cands);
    const idx = t.nextBlocked++;
    const suffix = [nm(`bs${idx}`)];
    const trackName = nm(`bt${idx}`);
    await server.sendPublishBlocked(t.reqId, suffix, trackName); // PUBLISH_BLOCKED on the same stream
    t.blockedSent.add(`${sufKey(suffix)}|${new TextDecoder().decode(trackName)}`);
    await flush();
    rec(Op.SEND_PUBLISH_BLOCKED, 1, { requestId: t.reqId, outcome: 1 });
  }

  async function opCancelTracks(): Promise<void> {
    const cands = [...trackSubs.values()].filter((t) => t.state === 'pending' || t.state === 'active');
    if (cands.length === 0) { rec(Op.CANCEL_TRACKS, 0, { outcome: 0 }); return; }
    const t = prng.pick(cands);
    await client.cancelTracks(t.reqId); // close the continuing request stream
    await flush();
    t.state = 'cancelled';
    rec(Op.CANCEL_TRACKS, 0, { requestId: t.reqId, outcome: 1 });
  }

  // ── main loop ───────────────────────────────────────────────────────────
  const opCodes = version === 18 ? [...SUBSCRIBE_OPS, ...FETCH_OPS, ...PUBLISH_OPS, ...CONTINUING_OPS] : SUBSCRIBE_OPS;
  for (step = 1; step <= opts.steps; step++) {
    const op = prng.pick(opCodes);
    switch (op) {
      case Op.SUBSCRIBE: await opSubscribe(); break;
      case Op.ACCEPT: await opAccept(); break;
      case Op.REJECT: await opReject(); break;
      case Op.SEND: await opSend(); break;
      case Op.UNSUBSCRIBE: await opUnsubscribe(); break;
      case Op.FETCH: await opFetch(); break;
      case Op.ACCEPT_FETCH: await opAcceptFetch(); break;
      case Op.REJECT_FETCH: await opRejectFetch(); break;
      case Op.OPEN_FETCH_STREAM: await opOpenFetchStream(); break;
      case Op.SEND_FETCH_OBJECT: await opSendFetchObject(); break;
      case Op.SEND_FETCH_EOR: await opSendFetchEor(); break;
      case Op.CANCEL_FETCH: await opCancelFetch(); break;
      case Op.PUBLISH: await opPublish(); break;
      case Op.ACCEPT_PUBLISH: await opAcceptPublish(); break;
      case Op.REJECT_PUBLISH: await opRejectPublish(); break;
      case Op.SEND_PUBLISH_OBJECT: await opSendPublishObject(); break;
      case Op.PUBLISH_DONE: await opPublishDone(); break;
      case Op.SUBSCRIBE_NAMESPACE: await opSubscribeNamespace(); break;
      case Op.ACCEPT_NAMESPACE: await opAcceptNamespace(); break;
      case Op.REJECT_NAMESPACE: await opRejectNamespace(); break;
      case Op.SEND_NAMESPACE: await opSendNamespace(); break;
      case Op.SEND_NAMESPACE_DONE: await opSendNamespaceDone(); break;
      case Op.CANCEL_NAMESPACE: await opCancelNamespace(); break;
      case Op.SUBSCRIBE_TRACKS: await opSubscribeTracks(); break;
      case Op.ACCEPT_TRACKS: await opAcceptTracks(); break;
      case Op.REJECT_TRACKS: await opRejectTracks(); break;
      case Op.SEND_PUBLISH_BLOCKED: await opSendPublishBlocked(); break;
      case Op.CANCEL_TRACKS: await opCancelTracks(); break;
      case Op.QUIESCE: default: await quiesce(pair, deliverySig); recQuiesce(); break;
    }
    assertInvariants(false);
  }

  // Final convergence: drain (delivery-aware), then assert exact delivery.
  step++;
  await quiesce(pair, deliverySig);
  recQuiesce();
  assertInvariants(true);

  client.session.close();
  server.session.close();
  return { hash: fnv1a64(log), log };
}
