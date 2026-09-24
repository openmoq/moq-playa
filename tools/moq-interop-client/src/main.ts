/**
 * moq-playa interop test client.
 *
 * Emits TAP 14 per docs/TEST-CLIENT-INTERFACE.md. Verdict discipline:
 *
 *   - a case passes ONLY on its named positive outcome;
 *   - timeout is a FAILURE, never a pass and never a SKIP;
 *   - a session close before the expected outcome is a FAILURE;
 *   - responses match on request identity AND exact message type — never
 *     "any message carrying this id", never a loose set of related types;
 *   - every async callback outcome is folded into the verdict; nothing rests
 *     on a bare sleep.
 */
import { MoqtConnection } from "@moqt/webtransport";
import type { ControlMessage } from "@moqt/transport";
import { teardown as teardownPeer } from "./teardown.js";
import { pathToFileURL } from "node:url";
import { varint } from "@moqt/transport";
import {
  connectInteropWebTransport,
  selectRelayTransport,
  transportSecurityDiagnostic,
} from "./transport-factory.js";

// ---------------------------------------------------------------- environment
const RELAY_URL = process.env.RELAY_URL ?? "";
const TESTCASE = process.env.TESTCASE ?? "";
const VERBOSE = /^(1|true)$/i.test(process.env.VERBOSE ?? "");
const TLS_DISABLE_VERIFY = /^(1|true)$/i.test(process.env.TLS_DISABLE_VERIFY ?? "");
const CERT_PATH = process.env.CERT_PATH ?? "/certs/cert.pem";
// Diagnostic ONLY. The tap interposes TransformStream/pipeTo layers on every
// stream and can perturb backpressure, cancellation, and error identity, so the
// normal client path must use the raw transport. VERBOSE controls printing; it
// must never control whether transport semantics are interposed.
const WIRE_TAP = /^(1|true)$/i.test(process.env.WIRE_TAP ?? "");
// Bound on observing the transport close settle. Overridable for diagnosis of
// peers whose close acknowledgement is slow; the default stays strict.
const CLOSE_BOUND_MS = Number(process.env.CLOSE_BOUND_MS ?? "3000");
// Inbound request credit advertised in legacy (draft-16) CLIENT_SETUP. Exposed
// only so a discriminator can advertise ZERO and prove inbound requests are
// then correctly refused; that refusal is compliant and must not be weakened.
const LEGACY_MAX_REQUEST_ID = BigInt(process.env.LEGACY_MAX_REQUEST_ID ?? "100");

// --- test seams. Production behaviour is unchanged: BOUND_SCALE is 1 and
// connectImpl is the real connectPeer. Discriminator tests replace the peer
// factory and compress the bounds so induced silence is cheap to assert.
export let BOUND_SCALE = 1;
const bound = (ms: number) => Math.max(20, Math.round(ms * BOUND_SCALE));
export function __setBoundScale(v: number) { BOUND_SCALE = v; }

/** MOQT_DRAFT is THE draft selector. The old scaffold read DRAFT_VERSION while
 *  compose sets MOQT_DRAFT, so a planned draft-16 row silently ran the default.
 *  A non-empty unsupported value fails closed rather than defaulting. */
const SUPPORTED_DRAFTS = [18, 16] as const;
function selectDraft(): number {
  const raw = (process.env.MOQT_DRAFT ?? "").trim();
  if (raw === "") return 18;
  const n = Number(raw.replace(/^draft-/, ""));
  if (!Number.isInteger(n) || !SUPPORTED_DRAFTS.includes(n as any)) {
    throw new Error(`unsupported MOQT_DRAFT '${raw}' (supported: ${SUPPORTED_DRAFTS.join(", ")})`);
  }
  return n;
}
/** Over WebTransport these are WT-Available-Protocols values, not QUIC ALPNs. */
function protocolsFor(draft: number): string[] | undefined {
  if (draft === 18) return ["moqt-18"];
  if (draft === 16) return ["moqt-16"];
  return undefined; // draft 14: plain h3 + in-band CLIENT_SETUP
}

const NAMESPACE = ["moq-test", "interop"];   // runner contract, as moq-dev-js sends
const TRACK = "test-track";
const MISSING_NAMESPACE = ["nonexistent", "namespace"];
const MISSING_TRACK = "test-track";

const enc = new TextEncoder();
const nsBytes = (parts: string[]) => parts.map((p) => enc.encode(p));
const diag = (m: string) => { if (VERBOSE) process.stderr.write(`# ${m}\n`); };

// ------------------------------------------------------------------ transport
async function makeTransport(url: string, draft: number): Promise<any> {
  return selectRelayTransport(url, draft, {
    webtransport: async (target, selectedDraft) => {
      const protocols = protocolsFor(selectedDraft);
      return connectInteropWebTransport(target, {
        ...(protocols ? { protocols } : {}),
        disableCertificateVerification: TLS_DISABLE_VERIFY,
        certificatePath: CERT_PATH,
        onTapComment: (message) => process.stdout.write(`# ${message}\n`),
      });
    },
    quic: async (target) => {
      const { connectQuic } = await import("@moqt/quic");
      return connectQuic(target, { allowUnauthorized: TLS_DISABLE_VERIFY });
    },
  });
}

// Map-aware, bigint-safe serializer. `parameters` / track-property blocks are
// JavaScript Maps; plain JSON.stringify renders a Map as {} and would silently
// hide the very parameter a peer report is about. Numeric parameter keys are
// rendered in hex so wire type codes (e.g. 0x22) are readable as such.
function jsonSafe(v: any): any {
  if (typeof v === "bigint") return String(v);
  if (v instanceof Map)
    return Object.fromEntries([...v.entries()].map(([k, val]) => [
      typeof k === "bigint" || typeof k === "number" ? `0x${BigInt(k).toString(16)}` : String(k),
      jsonSafe(val),
    ]));
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const o: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) o[k] = jsonSafe(val);
    return o;
  }
  return v;
}

// ------------------------------------------------------------------ wire tap
// Diagnostic only: logs raw bytes in both directions without altering framing,
// so "did we send PUBLISH_NAMESPACE" and "did the peer answer on that stream"
// are answered from the wire rather than inferred from a library callback.
const hexHead = (u: Uint8Array, n = 40) => Buffer.from(u.slice(0, n)).toString("hex");

function tapReadable(rs: any, tag: string): any {
  return rs.pipeThrough(new TransformStream({
    transform(c: Uint8Array, ctrl: any) { diag(`wire ${tag} <- ${c.byteLength}B ${hexHead(c)}`); ctrl.enqueue(c); },
    flush() { diag(`wire ${tag} <- FIN`); },
  }));
}
function tapWritable(ws: any, tag: string): any {
  const t = new TransformStream({
    transform(c: Uint8Array, ctrl: any) { diag(`wire ${tag} -> ${c.byteLength}B ${hexHead(c)}`); ctrl.enqueue(c); },
  });
  t.readable.pipeTo(ws).catch((e: any) => diag(`wire ${tag} -> pipe ended: ${e}`));
  return t.writable;
}
function tapTransport(transport: any, label: string): any {
  let n = 0;
  const memo = new Map<string, any>();
  const wrapBidi = (st: any, dir: string) => {
    const id = `${label}#${dir}${++n}`;
    diag(`wire ${id} opened`);
    return { readable: tapReadable(st.readable, id), writable: tapWritable(st.writable, id) };
  };
  const once = (k: string, f: () => any) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
  return new Proxy(transport, {
    get(t: any, prop: string | symbol) {
      if (prop === "createUnidirectionalStream")
        return async (...a: any[]) => tapWritable(await t.createUnidirectionalStream(...a), `${label}#outUni${++n}`);
      if (prop === "createBidirectionalStream")
        return async (...a: any[]) => wrapBidi(await t.createBidirectionalStream(...a), "out");
      if (prop === "incomingBidirectionalStreams")
        return once("bidi", () => t.incomingBidirectionalStreams.pipeThrough(new TransformStream({
          transform(st: any, ctrl: any) { ctrl.enqueue(wrapBidi(st, "in")); },
        })));
      if (prop === "incomingUnidirectionalStreams")
        return once("uni", () => t.incomingUnidirectionalStreams.pipeThrough(new TransformStream({
          transform(st: any, ctrl: any) { ctrl.enqueue(tapReadable(st, `${label}#inUni${++n}`)); },
        })));
      const v = Reflect.get(t, prop, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

// -------------------------------------------------------------- response inbox
type Waiter = { rid: bigint; types: string[]; resolve: (m: ControlMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Installed BEFORE any request is emitted. publishNamespace()/subscribe()
 * return after their write completes, so a zero-latency peer can answer before
 * a per-request handler could be attached. The inbox buffers parsed control
 * messages until a waiter claims the exact (requestId, type).
 */
export class Inbox {
  private buffered: ControlMessage[] = [];
  private waiters: Waiter[] = [];
  private closed: { error?: number; reason?: string } | null = null;

  deliver(msg: ControlMessage) {
    const rid = (msg as any).requestId;
    diag(`inbox: type=${(msg as any).type} requestId=${rid ?? "none"}`);
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (rid !== undefined && BigInt(rid) === w.rid && w.types.includes((msg as any).type)) {
        clearTimeout(w.timer); this.waiters.splice(i, 1); w.resolve(msg); return;
      }
    }
    this.buffered.push(msg);
  }
  notifyClosed(error?: number, reason?: string) {
    this.closed = { error, reason };
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error(`session closed before response (error=${error ?? "none"} reason=${reason ?? "none"})`));
    }
  }
  /** Resolve on the exact (requestId, type); reject on timeout or close. */
  await(rid: bigint, types: string[], ms: number, label: string): Promise<ControlMessage> {
    for (let i = 0; i < this.buffered.length; i++) {
      const m = this.buffered[i];
      const r = (m as any).requestId;
      if (r !== undefined && BigInt(r) === rid && types.includes((m as any).type)) {
        this.buffered.splice(i, 1); return Promise.resolve(m);
      }
    }
    if (this.closed) {
      return Promise.reject(new Error(`session already closed before ${label}`));
    }
    return new Promise<ControlMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.timer !== timer);
        reject(new Error(`timeout after ${ms}ms awaiting ${types.join("|")} for ${label}`));
      }, ms);
      this.waiters.push({ rid, types, resolve, reject, timer });
    });
  }
}

type Peer = { conn: any; transport: any; inbox: Inbox };

/** Per-case fatal signal. onError, stray async faults and publisher-response
 *  rejections all land here and are raced against every expected outcome, so a
 *  request-stream reset can no longer masquerade as a timeout. */
class Fatal {
  private err: Error | null = null;
  private wake: Array<(e: Error) => void> = [];
  raise(e: unknown, where: string) {
    const err = e instanceof Error ? e : new Error(String(e));
    err.message = `${where}: ${err.message}`;
    if (!this.err) this.err = err;
    for (const w of this.wake.splice(0)) w(err);
    diag(`fatal(${where}): ${err.message}${err.stack ? " | " + err.stack.split("\n")[1]?.trim() : ""}`);
  }
  get raised() { return this.err; }
  /** Reject as soon as a fatal arrives; never resolves on its own. */
  promise(): Promise<never> {
    if (this.err) return Promise.reject(this.err);
    return new Promise<never>((_r, rej) => this.wake.push(rej));
  }
  /** Race an outcome against the fatal signal. */
  async race<T>(p: Promise<T>): Promise<T> {
    if (this.err) throw this.err;
    return (await Promise.race([p, this.promise()])) as T;
  }
}

/** Peers created by the active case, torn down in finally so a failed case
 *  cannot leak a live connection into the ones that follow. */
export class CaseScope {
  readonly fatal = new Fatal();
  private peers: Peer[] = [];
  track(p: Peer) {
    if (!this.peers.includes(p)) this.peers.push(p);
    return p;
  }
  qlog: string[] = [];
  qlogSeen = 0;
  /** Race an outcome against this case's fatal signal, so a request-stream
   *  reset surfaces as itself instead of as a timeout. */
  race<T>(p: Promise<T>): Promise<T> { return this.fatal.race(p); }
  async teardownAll(): Promise<string[]> {
    const problems: string[] = [];
    for (const p of this.peers.reverse()) {
      try { await teardown(p); } catch (e) { problems.push(String((e as Error).message ?? e)); }
    }
    this.peers = [];
    return problems;
  }
}

export type ConnectFn = (draft: number, label: string, scope: CaseScope) => Promise<Peer>;
let connectImpl: ConnectFn = (d, l, sc) => connectPeer(d, l, sc);
export function __setConnect(f: ConnectFn) { connectImpl = f; }

export interface ConnectPeerDependencies {
  makeTransport(url: string, draft: number): Promise<any>;
  makeConnection(draft: number): any;
}

const CONNECT_PEER_DEFAULTS: ConnectPeerDependencies = {
  makeTransport,
  makeConnection: (draft) => new MoqtConnection(draft as any),
};

export async function connectPeer(
  draft: number,
  label: string,
  scope: CaseScope,
  dependencies: ConnectPeerDependencies = CONNECT_PEER_DEFAULTS,
): Promise<Peer> {
  const raw = await dependencies.makeTransport(RELAY_URL, draft);
  const transport = WIRE_TAP ? tapTransport(raw, label) : raw;
  const conn = dependencies.makeConnection(draft);
  const inbox = new Inbox();
  // All three observers are installed before connect(), therefore before any
  // request can be emitted. onError is load-bearing: a request-stream reset,
  // early FIN, or malformed response arrives there and NOT through onMessage,
  // and without it such a failure is silently relabelled a timeout.
  conn.onMessage = (m: ControlMessage) => inbox.deliver(m);
  conn.onClose = (e?: number, r?: string) => inbox.notifyClosed(e, r);
  conn.onError = (e: Error) => scope.fatal.raise(e, `${label}.onError`);
  // Event shape is { type, stream_id, message } -- NOT { name, data }. Count
  // every event so observer silence is distinguishable from a filtered-out shape.
  (conn as any).onQlogEvent = (ev: any) => {
    scope.qlogSeen++;
    const type = String(ev?.type ?? ev?.name ?? "?");
    const msg = ev?.message ?? ev?.data;
    const kind = msg?.type ?? msg?.message_type ?? "";
    const line = `${label} ${type} kind=${kind} stream=${ev?.stream_id ?? "?"} ${JSON.stringify(jsonSafe(msg ?? ev)).slice(0, 600)}`;
    scope.qlog.push(line); diag(`qlog: ${line}`);
  };
  // Draft 16 carries inbound request credit in CLIENT_SETUP parameter
  // MAX_REQUEST_ID (0x02); its default is ZERO, which forbids the peer from
  // sending us any request. announce-subscribe deliberately asks the relay to
  // forward an inbound SUBSCRIBE, so without this the relay's request is
  // correctly refused by our own limit ("exceeds our MAX_REQUEST_ID 0").
  // Draft 18 negotiates this differently and must NOT carry the option.
  const setupOptions = draft === 16
    ? { maxRequestId: varint(LEGACY_MAX_REQUEST_ID) }
    : {};
  const peer = scope.track({ conn, transport, inbox });
  await conn.connect(transport, setupOptions);
  diag(`${label}: connected draft=${draft} negotiated protocol='${transport.protocol ?? ""}'`);
  return peer;
}

/** Clean teardown. A local close() is deliberately quiet and does not fire
 *  onClose, so the transport close is what we observe. */
const teardown = (p: Peer, boundMs = CLOSE_BOUND_MS) => teardownPeer(p, boundMs);

// ---------------------------------------------------------------------- cases
// Drafts 18 and 16 both accept PUBLISH_NAMESPACE with REQUEST_OK. draft-14's
// PUBLISH_NAMESPACE_OK is deliberately absent: 14 is not a registered lane, and
// listing it here would let the wrong kind pass.
const NS_ACCEPT = ["REQUEST_OK"];
const dec = new TextDecoder();

/** Emit a generic subscribe, keeping BOTH the pre-send request id and the
 *  operation itself. onRequestId can fire before the stream open/write later
 *  rejects; without owning that rejection the case would wait for a response
 *  that can never arrive. */
async function emitSubscribe(peer: Peer, scope: CaseScope, ns: string[], track: string, label: string): Promise<bigint> {
  let resolveId: (id: bigint) => void;
  const idP = new Promise<bigint>((r) => { resolveId = r; });
  const op = peer.conn.subscribe(nsBytes(ns), enc.encode(track), {
    onRequestId: (id: bigint) => resolveId(id),
  }) as Promise<unknown>;
  op.catch((e: unknown) => scope.fatal.raise(e, `${label}.subscribe`));
  return scope.race(Promise.race([
    idP,
    new Promise<bigint>((_r, rej) => setTimeout(() => rej(new Error(`no request id issued for ${label}`)), bound(5000))),
  ]));
}

/** Install the publisher's inbound-subscribe handler. The accept/reject call is
 *  async: its promise is owned here and awaited by the case, so a failed
 *  acceptance can never sit under a passing verdict. The request is validated
 *  on BOTH namespace tuple and track name before it is accepted. */
/** Bound any promise with a descriptive message (used where the outcome may
 *  legitimately arrive after a later message). */
function withBound<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_r, rej) => { t = setTimeout(() => rej(new Error(`${what} (within ${ms}ms)`)), ms); }),
  ]);
}

function installPublisherAccept(pub: Peer, scope: CaseScope) {
  // The inbound SUBSCRIBE is exposed as a PROMISE, not a boolean. A relay may
  // legitimately answer the subscriber's SUBSCRIBE_OK from its own state before
  // it forwards the SUBSCRIBE upstream to the publisher, so the two arrive in
  // either order. A synchronous `saw` check right after SUBSCRIBE_OK reads the
  // flag too early and fails a conforming peer.
  let resolveSeen: (v: { matched: boolean }) => void;
  const seen = new Promise<{ matched: boolean }>((r) => { resolveSeen = r; });
  const state = { saw: false, matched: false, settled: null as Promise<unknown> | null, seen };
  pub.conn.onSubscribe = (reqId: bigint, ns: Uint8Array[], trackName: Uint8Array) => {
    state.saw = true;
    const gotNs = ns.map((p) => dec.decode(p));
    const gotTrack = dec.decode(trackName);
    const nsOk = gotNs.length === NAMESPACE.length && gotNs.every((v, i) => v === NAMESPACE[i]);
    const trackOk = gotTrack === TRACK;
    diag(`publisher: inbound SUBSCRIBE ns=[${gotNs.join(",")}] track=${gotTrack}`);
    if (nsOk && trackOk) {
      state.matched = true;
      const op = pub.conn.acceptSubscribe(reqId, 1n) as Promise<unknown>;
      state.settled = Promise.resolve(op);
      state.settled.catch((e: unknown) => scope.fatal.raise(e, "publisher.acceptSubscribe"));
    } else {
      const op = pub.conn.rejectSubscribe(reqId, 1n, "unknown track") as Promise<unknown>;
      state.settled = Promise.resolve(op);
      state.settled.catch((e: unknown) => scope.fatal.raise(e, "publisher.rejectSubscribe"));
    }
    resolveSeen({ matched: state.matched });
  };
  return state;
}

async function announceAccepted(peer: Peer, scope: CaseScope, label: string): Promise<bigint> {
  const rid = await scope.race(Promise.resolve(peer.conn.publishNamespace(nsBytes(NAMESPACE))) as Promise<bigint>);
  await scope.race(peer.inbox.await(BigInt(rid), NS_ACCEPT, bound(5000), `${label} publishNamespace accept`));
  return BigInt(rid);
}

export async function caseSetupOnly(draft: number, scope: CaseScope) {
  scope.track(await connectImpl(draft, "setup", scope));
  // teardown happens in the case runner's finally; an error or unsettled close
  // there fails the case.
}

export async function caseAnnounceOnly(draft: number, scope: CaseScope) {
  const p = scope.track(await connectImpl(draft, "announce", scope));
  await announceAccepted(p, scope, "announce");
}

export async function casePublishNamespaceDone(draft: number, scope: CaseScope) {
  const p = scope.track(await connectImpl(draft, "ns-done", scope));
  const rid = await announceAccepted(p, scope, "ns-done");
  // draft-18 has no PUBLISH_NAMESPACE_DONE message: withdrawal cancels the
  // request stream and there is no peer ACK. The application-visible contract
  // is that the call settles and local state is reclaimed, which the second
  // call proves by rejecting.
  await scope.race(Promise.resolve(p.conn.publishNamespaceDone(rid)));
  let secondRejected = false;
  try { await p.conn.publishNamespaceDone(rid); }
  catch { secondRejected = true; }
  if (!secondRejected) throw new Error("withdrawal did not reclaim local state: a second publishNamespaceDone succeeded");
}

export async function caseSubscribeError(draft: number, scope: CaseScope) {
  const p = scope.track(await connectImpl(draft, "sub-error", scope));
  const id = await emitSubscribe(p, scope, MISSING_NAMESPACE, MISSING_TRACK, "sub-error");
  const msg = await scope.race(p.inbox.await(id, ["REQUEST_ERROR", "SUBSCRIBE_OK"], bound(8000), "subscribe to unknown namespace"));
  const t = (msg as any).type;
  if (t !== "REQUEST_ERROR") throw new Error(`expected REQUEST_ERROR, got ${t}`);
  diag(`sub-error: code=${(msg as any).errorCode ?? "?"} reason=${(msg as any).reason ?? ""}`);
}

export async function caseAnnounceSubscribe(draft: number, scope: CaseScope) {
  const pub = scope.track(await connectImpl(draft, "publisher", scope));
  const acc = installPublisherAccept(pub, scope);   // installed BEFORE announcing
  await announceAccepted(pub, scope, "publisher");

  const sub = scope.track(await connectImpl(draft, "subscriber", scope));
  const id = await emitSubscribe(sub, scope, NAMESPACE, TRACK, "subscriber");
  const msg = await scope.race(sub.inbox.await(id, ["SUBSCRIBE_OK", "REQUEST_ERROR"], bound(8000), "subscribe to announced track"));
  if ((msg as any).type !== "SUBSCRIBE_OK") throw new Error(`expected SUBSCRIBE_OK, got ${(msg as any).type}`);
  // Await the inbound SUBSCRIBE under its own bound rather than sampling a flag:
  // it may arrive after the subscriber's SUBSCRIBE_OK.
  const seen = await scope.race(withBound(acc.seen, bound(8000), "publisher never received the inbound SUBSCRIBE"));
  if (!seen.matched) throw new Error("publisher received a SUBSCRIBE that did not match the announced namespace/track");
  if (acc.settled) await scope.race(acc.settled);   // a failed acceptance fails the case
}

export async function caseSubscribeBeforeAnnounce(draft: number, scope: CaseScope) {
  const sub = scope.track(await connectImpl(draft, "subscriber", scope));
  const id = await emitSubscribe(sub, scope, NAMESPACE, TRACK, "subscriber");
  const early = sub.inbox.await(id, ["SUBSCRIBE_OK", "REQUEST_ERROR"], bound(12000), "subscribe before announce");
  early.catch(() => { /* consumed below; kept from becoming a stray rejection */ });

  // The publisher half runs regardless of an immediate rejection, or a relay
  // that rejects instantly would pass a case named for announcing.
  await new Promise((r) => setTimeout(r, bound(500)));
  const pub = scope.track(await connectImpl(draft, "publisher", scope));
  const acc = installPublisherAccept(pub, scope);
  await announceAccepted(pub, scope, "publisher");

  const msg = await scope.race(early);   // timeout or close still fails here
  const t = (msg as any).type;
  if (t !== "SUBSCRIBE_OK" && t !== "REQUEST_ERROR") throw new Error(`unexpected ${t}`);
  if (acc.settled) await scope.race(acc.settled);
  diag(`subscribe-before-announce resolved as ${t}`);
}

// Last resort only: the callback promises above are owned, so these should not
// fire in normal operation. When they do, the fault is attributed to the case
// that is running rather than merely logged.
let ACTIVE: CaseScope | null = null;
process.on("unhandledRejection", (e) => {
  if (ACTIVE) ACTIVE.fatal.raise(e, "unhandledRejection"); else diag(`unhandled rejection outside a case: ${String(e)}`);
});
process.on("uncaughtException", (e) => {
  if (ACTIVE) ACTIVE.fatal.raise(e, "uncaughtException"); else diag(`uncaught exception outside a case: ${String(e)}`);
});

// ------------------------------------------------------------------ TAP driver
const CASES: Array<[string, (d: number, s: CaseScope) => Promise<void>]> = [
  ["setup-only", caseSetupOnly],
  ["announce-only", caseAnnounceOnly],
  ["publish-namespace-done", casePublishNamespaceDone],
  ["subscribe-error", caseSubscribeError],
  ["announce-subscribe", caseAnnounceSubscribe],
  ["subscribe-before-announce", caseSubscribeBeforeAnnounce],
];

async function main() {
  const out = (s: string) => process.stdout.write(s + "\n");
  out("TAP version 14");
  out("# moq-playa interop client");
  if (!RELAY_URL) { out("Bail out! RELAY_URL is not set"); process.exit(1); }
  let draft: number;
  try { draft = selectDraft(); }
  catch (e) { out(`Bail out! ${(e as Error).message}`); process.exit(1); return; }
  out(`# Relay: ${RELAY_URL}`);
  out(`# Draft: ${draft} (MOQT_DRAFT='${process.env.MOQT_DRAFT ?? ""}')`);
  out(`# Offered protocols: ${(protocolsFor(draft) ?? ["<none: draft-14 in-band>"]).join(",")}`);
  const securityDiagnostic = transportSecurityDiagnostic(RELAY_URL, TLS_DISABLE_VERIFY);
  if (securityDiagnostic) out(`# ${securityDiagnostic}`);

  const selected = TESTCASE ? CASES.filter(([n]) => n === TESTCASE) : CASES;
  if (TESTCASE && selected.length === 0) { out(`Bail out! unknown TESTCASE '${TESTCASE}'`); process.exit(1); }
  out(`1..${selected.length}`);

  let failed = 0;
  for (let i = 0; i < selected.length; i++) {
    const [name, fn] = selected[i];
    const scope = new CaseScope();
    ACTIVE = scope;                       // stray async faults attach to this case
    let verdict: Error | null = null;
    try {
      await fn(draft, scope);
    } catch (e) {
      verdict = e instanceof Error ? e : new Error(String(e));
    }
    // Snapshot the fatal signal BEFORE teardown. Closing the session makes the
    // peer's in-flight inbound requests fail (failInboundRequest -> onError);
    // that is a consequence of our own intentional close, not a case failure,
    // so it must not turn an already-passing case red. A genuine close problem
    // still fails via the cleanup list below.
    const fatalBeforeTeardown = scope.fatal.raised;
    // Teardown always runs, so a failed case cannot leak a live connection into
    // the ones that follow. It never overwrites an existing verdict; a clean
    // case that fails to tear down cleanly does fail.
    const cleanup = await scope.teardownAll();
    if (!verdict && fatalBeforeTeardown) verdict = fatalBeforeTeardown;
    if (!verdict && cleanup.length) verdict = new Error(`teardown failed: ${cleanup.join("; ")}`);
    const afterTeardown = scope.fatal.raised;
    if (!fatalBeforeTeardown && afterTeardown)
      scope.qlog.push(`post-teardown onError (not case-fatal): ${afterTeardown.message}`);
    ACTIVE = null;
    if (!verdict) {
      out(`ok ${i + 1} - ${name}`);
    } else {
      failed++;
      out(`not ok ${i + 1} - ${name}`);
      out("  ---");
      out(`  message: ${String(verdict.message).replace(/\n/g, " ")}`);
      if (cleanup.length) out(`  teardown: ${cleanup.join("; ").replace(/\n/g, " ")}`);
      if (scope.qlog.length) out(`  qlog_control_events: ${scope.qlog.length}`);
      out("  ...");
    }
    for (const q of scope.qlog) diag(`qlog[${name}] ${q}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

// A transport-level rejection must not escape and truncate the plan: TAP that
// promises 1..6 and emits one row is malformed, which is a harness fault rather
// than a peer result. Stray rejections are recorded and attributed to the case
// that is running.
// Auto-run ONLY as the process entrypoint: importing this module from a test
// must not start a client run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stdout.write(`Bail out! ${String(e)}\n`); process.exit(1); });
}
