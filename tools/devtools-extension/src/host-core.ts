// The OWNER side of the local diagnostic carrier, as a pure state machine.
//
// One DevTools document owns one of these per relay channel. It never touches
// chrome.* or the DOM: the glue (`owner.js`) feeds it carrier reply packets and
// port events, and it answers through `HostIO` with encoded carrier requests to
// send, decoded-and-validated protocol frames for the panel's adapter, and
// host-state changes to display.
//
// Rules enforced here (packages/devtools-protocol/CARRIER.md, PROTOCOL.md):
// exactly one EXCHANGE outstanding, each receipt echoed once; a data reply with
// no exchange outstanding is a violation, a terminal `closed` packet is accepted
// at any time; a poll may be empty, but a command exchange (bootstrap discover,
// rediscover, attach, refresh, detach) must contain its correctly correlated
// outcome or the carrier is closed; every frame is decoded and its identity
// checked before it is adopted or forwarded; Pause never withholds credit; an
// owner-side timeout actively relinquishes a silent channel. The successful
// attach request's id is kept for the lease's lifetime so a later
// `error(not-found)` on exactly that pair is a withdrawal (idempotent, and it
// may follow a failed command); any other unsolicited frame is a violation.
//
// Recording (PROTOCOL.md "record.*"): the owner holds the recording id and
// token and never hands the token to a view; `record.export` returns its first
// chunk in the request exchange and the rest one per poll under the SAME
// request id, target and export id, in index order, until `final`; while an
// export is incomplete the owner yields credit immediately between exchanges.
// Three export outcomes are kept apart: a chunk gap, duplicate or foreign
// identity is the PAGE's fault (protocol violation, carrier closed); a page
// `error` reply refuses that export and keeps the lease; OUR byte budget or
// deadline is a local policy — the wire has no cancel command, so the owner
// closes this diagnostic carrier (releasing the page lease) with a
// `local-policy` reason rather than forgetting the correlation and blaming
// the page's next valid chunk. Detach, withdrawal and any terminal state
// release the recording and abort an export.
import {
  decodeCarrierReply, decodeMessage, encodeCarrierRequest, encodeMessage, PROTOCOL_VERSION, sameTarget,
} from '@openmoq/devtools-protocol';
import type { AttachmentTarget, CarrierReply, Message, SnapshotScope, SourceDescriptor } from '@openmoq/devtools-protocol';

export type HostPhase =
  | 'idle'            // no carrier yet
  | 'bootstrapping'   // discover handed to the relay, hello awaited
  | 'discovered'      // hello received, no lease
  | 'attaching'       // attach sent, snapshot awaited
  | 'attached'        // lease bound; batches flow
  | 'withdrawn'       // the page withdrew the attached source; carrier still open
  | 'closed'          // terminal carrier packet, or owner closed it
  | 'lost';           // port gone or page silent with no terminal packet

export interface HostState {
  readonly phase: HostPhase;
  readonly generation: number;
  /** For `closed`: the carrier reason (+ registry reason). For `lost`/`withdrawn`: what was observed. */
  readonly reason: string | null;
  readonly sources: readonly SourceDescriptor[];
  readonly target: AttachmentTarget | null;
  /** Last command the page answered with an error, for the status line. */
  readonly lastError: { readonly command: string; readonly code: string; readonly message: string } | null;
  readonly queued: number;
  readonly inFlight: boolean;
  /** Token-free recording state held by this owner: present from `record.started` until released. */
  readonly recording: { readonly recordingId: string; readonly exporting: { readonly chunks: number; readonly bytes: number } | null } | null;
}

export interface HostIO {
  /** An encoded carrier request for the relay, current generation. */
  send(packet: string): void;
  /** A protocol frame that passed `decodeMessage` and its correlation checks, in exchange order. */
  frame(encoded: string): void;
  state(state: HostState): void;
  /** Returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  /** A completed export: the reassembled trace text, never the token. */
  exported(result: { readonly recordingId: string; readonly exportId: string; readonly text: string; readonly bytes: number }): void;
}

export interface HostOptions {
  readonly ownerId: string;
  readonly pollAttachedMs?: number;
  readonly pollIdleMs?: number;
  readonly replyTimeoutMs?: number;
  readonly maxQueued?: number;
  /** Generation counter to continue from, so one owner's generations stay monotonic across relay ports. */
  readonly generation?: number;
  /** Total UTF-8 bytes an export may reach before it is abandoned. */
  readonly exportMaxBytes?: number;
  /** Time an export may take from its request to its final chunk. */
  readonly exportTimeoutMs?: number;
}

type Command =
  | { kind: 'discover' }
  | { kind: 'attach'; sourceId: string; runId: string }
  | { kind: 'refresh'; scope: SnapshotScope }
  | { kind: 'detach' }
  | { kind: 'record.start' }
  | { kind: 'record.stop' }
  | { kind: 'record.export' };

/** The one outstanding exchange. A poll needs no outcome; a command needs exactly its own. */
type Exchange =
  | { kind: 'poll' }
  | { kind: 'command'; requestId: string; command: Command; target: AttachmentTarget | null; satisfied: boolean };

const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;

function sameScope(a: SnapshotScope, b: SnapshotScope): boolean {
  switch (a.kind) {
    case 'source': return b.kind === 'source';
    case 'track': return b.kind === 'track' && a.trackId === b.trackId;
    case 'delivery': return b.kind === 'delivery' && a.deliveryId === b.deliveryId;
    case 'group': return b.kind === 'group' && a.sessionId === b.sessionId && a.trackAlias === b.trackAlias && a.groupId === b.groupId;
  }
}

export class HostCore {
  private readonly ownerId: string;
  private readonly pollAttachedMs: number;
  private readonly pollIdleMs: number;
  private readonly replyTimeoutMs: number;
  private readonly maxQueued: number;
  private readonly exportMaxBytes: number;
  private readonly exportTimeoutMs: number;
  private phase: HostPhase = 'idle';
  private generation = 0;
  private reason: string | null = null;
  private sources: readonly SourceDescriptor[] = [];
  private target: AttachmentTarget | null = null;
  private attachRequestId: string | null = null;
  /** The last withdrawn (attach requestId, target) pair: its notice may arrive again and must stay idempotent. */
  private withdrawn: { requestId: string; target: AttachmentTarget } | null = null;
  private lastError: HostState['lastError'] = null;
  private receipt: string | null = null;
  private exchange: Exchange | null = null;
  private nextRequest = 0;
  private readonly queue: Command[] = [];
  private cancelPoll: (() => void) | null = null;
  private cancelTimeout: (() => void) | null = null;
  /** The recording this owner started on the current lease, with the token that only this owner may use. */
  private recording: { recordingId: string; token: string } | null = null;
  /** An export in progress: chunks arrive under one correlation across several exchanges. */
  private exporting: { requestId: string; exportId: string | null; nextIndex: number; bytes: number; parts: string[]; cancelDeadline: (() => void) | null } | null = null;

  constructor(private readonly io: HostIO, options: HostOptions) {
    this.ownerId = options.ownerId;
    this.pollAttachedMs = options.pollAttachedMs ?? 250;
    this.pollIdleMs = options.pollIdleMs ?? 2000;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 5000;
    this.maxQueued = options.maxQueued ?? 8;
    this.generation = options.generation ?? 0;
    this.exportMaxBytes = options.exportMaxBytes ?? 8 * 1024 * 1024;
    this.exportTimeoutMs = options.exportTimeoutMs ?? 60000;
    if (!Number.isSafeInteger(this.generation) || this.generation < 0) throw new Error('Host generation must be a non-negative integer');
    for (const v of [this.pollAttachedMs, this.pollIdleMs, this.replyTimeoutMs, this.maxQueued, this.exportMaxBytes, this.exportTimeoutMs]) {
      if (!Number.isSafeInteger(v) || v <= 0) throw new Error('Host timing options must be positive integers');
    }
  }

  get state(): HostState {
    return { phase: this.phase, generation: this.generation, reason: this.reason, sources: this.sources, target: this.target,
      lastError: this.lastError, queued: this.queue.length, inFlight: this.exchange !== null,
      recording: this.recording ? { recordingId: this.recording.recordingId,
        exporting: this.exporting ? { chunks: this.exporting.parts.length, bytes: this.exporting.bytes } : null } : null };
  }

  /**
   * Begin a new channel generation. Returns the encoded `discover` the relay
   * must transfer with the new MessagePort. Everything from an older generation
   * (receipts, target, correlation) is dropped here, never carried over.
   */
  bootstrap(): string {
    this.cancelTimers();
    this.generation++;
    this.phase = 'bootstrapping'; this.reason = null;
    this.sources = []; this.target = null; this.attachRequestId = null; this.withdrawn = null; this.lastError = null;
    this.releaseRecording('new channel');
    this.receipt = null; this.queue.length = 0;
    const requestId = this.mint();
    this.exchange = { kind: 'command', requestId, command: { kind: 'discover' }, target: null, satisfied: false };
    const discover = encodeMessage({ ...common, kind: 'discover', requestId, ownerId: this.ownerId });
    this.armTimeout();
    this.emit();
    return discover;
  }

  /** A packet from the relay for `generation`. Older generations are ignored. */
  receive(packet: unknown, generation: number): void {
    if (generation !== this.generation || !this.live()) return;
    const decoded = decodeCarrierReply(packet);
    if (!decoded.ok) { this.violation(`invalid carrier packet from page (${decoded.error.code})`); return; }
    const reply: CarrierReply = decoded.packet;
    if (reply.kind === 'closed') {
      // The terminal packet may follow the one data reply, or arrive on its own.
      this.terminal('closed', reply.reason === 'registry-closed' ? `registry-closed · ${reply.connectionReason}` : reply.reason);
      return;
    }
    const exchange = this.exchange;
    if (exchange === null) { this.violation('carrier data reply with no exchange outstanding'); return; }
    this.clearTimeout();
    this.exchange = null;
    this.receipt = reply.receipt;
    for (const frame of reply.frames) {
      if (!this.live()) return;      // a violation inside the exchange closed us
      this.applyFrame(frame, exchange);
    }
    if (!this.live()) return;
    if (exchange.kind === 'command' && !exchange.satisfied) {
      this.violation(`${exchange.command.kind} exchange ended without its outcome`); return;
    }
    this.next();
  }

  /** The port disconnected: nothing can be sent any more. No terminal packet was seen. */
  lost(detail: string): void {
    if (!this.live()) return;
    this.terminal('lost', detail);
  }

  /** Owner-initiated close. Returns the encoded `close` request to send, if a channel is open. */
  close(): string | null {
    if (!this.live()) return null;
    this.terminal('closed', 'owner-closed');
    return encodeCarrierRequest({ kind: 'close' });
  }

  // ── Commands (queued, bounded, one exchange in flight) ────────────────────

  rediscover(): boolean { return !this.queuedKind('discover') && this.enqueue({ kind: 'discover' }); }
  attach(sourceId: string, runId: string): boolean {
    if (this.target !== null || this.queuedKind('attach') || this.queuedKind('detach')) return false;
    return this.enqueue({ kind: 'attach', sourceId, runId });
  }
  /** Whole-source refreshes coalesce: one pending at a time is enough to resync every view. */
  refresh(scope: SnapshotScope = { kind: 'source' }): boolean {
    if (this.target === null) return false;
    if (scope.kind === 'source' && this.queuedScope()) return false;
    return this.enqueue({ kind: 'refresh', scope });
  }
  detach(): boolean { return this.target !== null && !this.queuedKind('detach') && this.enqueue({ kind: 'detach' }); }
  /** Start a recording on the attached source. Refused while this owner already holds one. */
  recordStart(): boolean {
    return this.target !== null && this.recording === null && !this.queuedKind('record.start') && this.enqueue({ kind: 'record.start' });
  }
  recordStop(): boolean {
    return this.target !== null && this.recording !== null && !this.queuedKind('record.stop') && this.enqueue({ kind: 'record.stop' });
  }
  /** Export the held recording. One export at a time. */
  recordExport(): boolean {
    return this.target !== null && this.recording !== null && this.exporting === null && !this.queuedKind('record.export') && this.enqueue({ kind: 'record.export' });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private live(): boolean { return this.phase !== 'idle' && this.phase !== 'closed' && this.phase !== 'lost'; }
  private mint(): string { return `r${++this.nextRequest}`; }
  /** Pending (in flight) or queued command of this kind. */
  private queuedKind(kind: Command['kind']): boolean {
    if (this.exchange?.kind === 'command' && this.exchange.command.kind === kind) return true;
    return this.queue.some(c => c.kind === kind);
  }

  private queuedScope(): boolean {
    if (this.exchange?.kind === 'command' && this.exchange.command.kind === 'refresh' && this.exchange.command.scope.kind === 'source') return true;
    return this.queue.some(c => c.kind === 'refresh' && c.scope.kind === 'source');
  }

  private enqueue(command: Command): boolean {
    if (!this.live() || this.phase === 'bootstrapping' || this.queue.length >= this.maxQueued) return false;
    this.queue.push(command);
    // Credit in hand and nothing in flight: a scheduled poll yields to the command.
    if (this.exchange === null && this.receipt !== null) { this.cancelPollTimer(); this.sendNext(); }
    this.emit();
    return true;
  }

  private next(): void {
    if (this.queue.length > 0) { this.sendNext(); return; }
    this.cancelPollTimer();
    // While an export is incomplete, credit goes straight back (a yield, not the observation cadence).
    const delay = this.exporting !== null ? 0 : this.target !== null ? this.pollAttachedMs : this.pollIdleMs;
    this.cancelPoll = this.io.schedule(() => { this.cancelPoll = null; this.poll(); }, delay);
    this.emit();
  }

  private poll(): void {
    if (!this.live() || this.exchange !== null || this.receipt === null) return;
    const receipt = this.receipt; this.receipt = null;
    this.exchange = { kind: 'poll' };
    this.io.send(encodeCarrierRequest({ kind: 'poll', receipt }));
    this.armTimeout();
    this.emit();
  }

  private sendNext(): void {
    if (!this.live() || this.exchange !== null || this.receipt === null) return;
    const command = this.queue.shift()!;
    const requestId = this.mint();
    let message: Message;
    switch (command.kind) {
      case 'discover': message = { ...common, kind: 'discover', requestId, ownerId: this.ownerId }; break;
      case 'attach': message = { ...common, kind: 'attach', requestId, target: { ownerId: this.ownerId, sourceId: command.sourceId, runId: command.runId } }; break;
      case 'refresh':
        if (this.target === null) { this.next(); return; }
        message = { ...common, kind: 'snapshot.request', requestId, target: this.target, scope: command.scope }; break;
      case 'detach':
        if (this.target === null) { this.next(); return; }
        message = { ...common, kind: 'detach', requestId, target: this.target }; break;
      case 'record.start':
        if (this.target === null || this.recording !== null) { this.next(); return; }
        message = { ...common, kind: 'record.start', requestId, target: this.target }; break;
      case 'record.stop':
        if (this.target === null || this.recording === null) { this.next(); return; }
        message = { ...common, kind: 'record.stop', requestId, target: this.target, recordingId: this.recording.recordingId, token: this.recording.token }; break;
      case 'record.export':
        if (this.target === null || this.recording === null || this.exporting !== null) { this.next(); return; }
        message = { ...common, kind: 'record.export', requestId, target: this.target, recordingId: this.recording.recordingId, token: this.recording.token };
        this.exporting = { requestId, exportId: null, nextIndex: 0, bytes: 0, parts: [],
          cancelDeadline: this.io.schedule(() => this.localPolicyClose(`export did not complete within ${this.exportTimeoutMs} ms`), this.exportTimeoutMs) };
        break;
    }
    this.exchange = { kind: 'command', requestId, command, target: this.target, satisfied: false };
    if (command.kind === 'attach') this.phase = 'attaching';
    const receipt = this.receipt; this.receipt = null;
    this.io.send(encodeCarrierRequest({ kind: 'request', receipt, message: encodeMessage(message) }));
    this.armTimeout();
    this.emit();
  }

  /** Validate one frame against the outstanding exchange and the held lease; adopt identity only after. */
  private applyFrame(encoded: string, exchange: Exchange): void {
    const decoded = decodeMessage(encoded);
    if (!decoded.ok) { this.violation(`undecodable protocol frame (${decoded.error.code} at ${decoded.error.path})`); return; }
    const m = decoded.message;
    const cmd = exchange.kind === 'command' && !exchange.satisfied && 'requestId' in m && m.requestId === exchange.requestId ? exchange : null;
    switch (m.kind) {
      case 'hello': {
        if (cmd?.command.kind !== 'discover' || m.ownerId !== this.ownerId) { this.violation('hello without a matching discover'); return; }
        cmd.satisfied = true;
        this.sources = m.sources;
        if (this.phase === 'bootstrapping') this.phase = 'discovered';
        break;
      }
      case 'snapshot': {
        if (cmd?.command.kind === 'attach') {
          const c = cmd.command;
          if (m.target.ownerId !== this.ownerId || m.target.sourceId !== c.sourceId || m.target.runId !== c.runId || m.scope.kind !== 'source') {
            this.violation('attach answered with a snapshot for another owner, source, run or scope'); return;
          }
          cmd.satisfied = true;
          this.target = m.target; this.attachRequestId = m.requestId; this.withdrawn = null; this.phase = 'attached'; this.reason = null;
        } else if (cmd?.command.kind === 'refresh') {
          if (cmd.target === null || !sameTarget(m.target, cmd.target) || !sameScope(m.scope, cmd.command.scope)) {
            this.violation('refresh answered for another attachment or scope'); return;
          }
          cmd.satisfied = true;
        } else { this.violation('snapshot without a pending request'); return; }
        break;
      }
      case 'batch':
        if (this.target === null || !sameTarget(m.target, this.target)) { this.violation('batch for an attachment this owner does not hold'); return; }
        break;
      case 'ack': {
        if (cmd === null || (cmd.command.kind !== 'detach' && cmd.command.kind !== 'record.stop') || cmd.target === null || !sameTarget(m.target, cmd.target)) {
          this.violation('ack without a pending detach or record.stop'); return;
        }
        cmd.satisfied = true;
        if (cmd.command.kind === 'detach') {
          this.releaseRecording('detached');
          this.target = null; this.attachRequestId = null; this.phase = 'discovered';
        }
        // record.stop acked: the recording stays held (stopped) so it can be exported.
        break;
      }
      case 'record.started': {
        if (cmd?.command.kind !== 'record.start' || cmd.target === null || !sameTarget(m.target, cmd.target)) { this.violation('record.started without a pending record.start'); return; }
        cmd.satisfied = true;
        this.recording = { recordingId: m.recordingId, token: m.token };
        return;   // never forwarded: the token is this owner's alone
      }
      case 'export.chunk': {
        const ex = this.exporting;
        const first = cmd?.command.kind === 'record.export' && ex !== null && ex.requestId === m.requestId && ex.exportId === null;
        const continued = ex !== null && ex.exportId !== null && ex.requestId === m.requestId && ex.exportId === m.exportId;
        if (ex === null || this.target === null || !sameTarget(m.target, this.target) || !(first || continued)) { this.violation('export.chunk without a matching export'); return; }
        if (first) { cmd!.satisfied = true; ex.exportId = m.exportId; }
        if (m.index !== ex.nextIndex) { this.violation(`export chunk ${m.index} arrived, expected ${ex.nextIndex}`); return; }
        const bytes = new TextEncoder().encode(m.data).byteLength;
        if (ex.bytes + bytes > this.exportMaxBytes) { this.localPolicyClose(`export exceeded ${this.exportMaxBytes} bytes`); return; }
        ex.parts.push(m.data); ex.bytes += bytes; ex.nextIndex++;
        if (m.final) {
          ex.cancelDeadline?.();
          const recordingId = this.recording?.recordingId ?? '';
          const text = ex.parts.join('');
          this.exporting = null;
          this.io.exported({ recordingId, exportId: m.exportId, text, bytes: ex.bytes });
        }
        return;   // chunks are reassembled here, not shown as facts
      }
      case 'error': {
        if (cmd !== null) {
          // The outcome of the outstanding command, which must name the attachment it was sent for.
          const c = cmd.command;
          if (c.kind === 'refresh' || c.kind === 'detach') {
            if (cmd.target === null || m.target === null || !sameTarget(m.target, cmd.target)) { this.violation(`${c.kind} refused for another attachment`); return; }
          } else if (c.kind === 'attach') {
            if (m.target !== null && (m.target.ownerId !== this.ownerId || m.target.sourceId !== c.sourceId || m.target.runId !== c.runId)) {
              this.violation('attach refused with a foreign target'); return;
            }
          } else if (c.kind === 'record.start' || c.kind === 'record.stop' || c.kind === 'record.export') {
            if (cmd.target === null || m.target === null || !sameTarget(m.target, cmd.target)) { this.violation(`${c.kind} refused for another attachment`); return; }
          } else if (m.target !== null) { this.violation('discover refused with a target'); return; }
          cmd.satisfied = true;
          this.lastError = { command: c.kind, code: m.code, message: m.message };
          if (c.kind === 'attach') this.phase = 'discovered';
          if (c.kind === 'record.export') this.abortExport(`${m.code}: ${m.message}`);
          // The page says the attachment is not current: the lease is gone, treat it as withdrawn.
          if ((c.kind === 'detach' || c.kind === 'refresh') && m.code === 'not-found' && this.target !== null) this.withdraw(`${c.kind} refused: ${m.code}`);
        } else if (m.code === 'not-found' && m.target !== null && this.attachRequestId === m.requestId && this.target !== null && sameTarget(m.target, this.target)) {
          // The documented delayed withdrawal notice for the lease this owner holds.
          this.withdraw(`${m.code}: ${m.message}`);
        } else if (m.code === 'not-found' && m.target !== null && this.withdrawn !== null && this.withdrawn.requestId === m.requestId && sameTarget(m.target, this.withdrawn.target)) {
          // The same notice again (a failed command may precede it): idempotent, not a violation.
        } else { this.violation('unsolicited error without a pending request'); return; }
        break;
      }
      default:
        // Commands never come back, and recording frames have no implementation to correlate to.
        this.violation(`unexpected frame kind ${m.kind} from the page`); return;
    }
    this.io.frame(encoded);
  }

  /** Drop the held recording and abort any export; the page's recorder keeps its own bounds. */
  private releaseRecording(why: string): void {
    if (this.exporting !== null) this.abortExport(why);
    this.recording = null;
  }
  /** The page refused or the lease ended: drop the export, keep whatever else still holds. */
  private abortExport(detail: string): void {
    const ex = this.exporting;
    if (ex === null) return;
    ex.cancelDeadline?.();
    this.exporting = null;
    this.lastError = { command: 'record.export', code: 'aborted', message: detail };
    this.emit();
  }
  /** OUR limit was hit mid-export: the only bounded cancellation on this wire is to close the carrier. */
  private localPolicyClose(detail: string): void {
    if (!this.live()) return;
    this.abortExport(detail);
    this.io.send(encodeCarrierRequest({ kind: 'close' }));
    this.terminal('closed', `local-policy · ${detail}`);
  }

  private withdraw(detail: string): void {
    this.releaseRecording('source withdrawn');
    if (this.target !== null && this.attachRequestId !== null) this.withdrawn = { requestId: this.attachRequestId, target: this.target };
    this.target = null; this.attachRequestId = null;
    this.phase = 'withdrawn'; this.reason = detail;
  }

  private violation(detail: string): void {
    if (!this.live()) return;
    this.io.send(encodeCarrierRequest({ kind: 'close' }));
    this.terminal('closed', `protocol-violation · ${detail}`);
  }

  private terminal(phase: 'closed' | 'lost', reason: string): void {
    this.cancelTimers();
    this.releaseRecording(reason);
    this.phase = phase; this.reason = reason;
    this.receipt = null; this.exchange = null;
    this.queue.length = 0;
    this.emit();
  }

  private armTimeout(): void {
    this.clearTimeout();
    this.cancelTimeout = this.io.schedule(() => {
      this.cancelTimeout = null;
      if (!this.live()) return;
      // Actively relinquish the channel (close first, while the glue still holds the port): the
      // page may still be holding our lease.
      this.io.send(encodeCarrierRequest({ kind: 'close' }));
      this.terminal('lost', `no reply within ${this.replyTimeoutMs} ms`);
    }, this.replyTimeoutMs);
  }
  private clearTimeout(): void { this.cancelTimeout?.(); this.cancelTimeout = null; }
  private cancelPollTimer(): void { this.cancelPoll?.(); this.cancelPoll = null; }
  private cancelTimers(): void { this.clearTimeout(); this.cancelPollTimer(); }
  private emit(): void { this.io.state(this.state); }
}
