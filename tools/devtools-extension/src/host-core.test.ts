/**
 * Owner-side carrier state machine against the shared fixtures and codecs.
 *
 * The fake IO records every encoded carrier request, every forwarded frame
 * and every state, and runs scheduled work only when the test says so.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeCarrierRequest, decodeMessage, encodeCarrierReply, encodeMessage, PROTOCOL_VERSION,
} from '@openmoq/devtools-protocol';
import type { Message } from '@openmoq/devtools-protocol';
import { batchFixture, fixtureSource, fixtureTarget, snapshotFixture } from '@openmoq/devtools-protocol/fixtures';
import { HostCore } from './host-core.js';
import type { HostState } from './host-core.js';
import type { Snapshot } from '@openmoq/devtools-protocol';

/** Decode a forwarded protocol frame or fail the test. */
const kindOf = (encoded: string): Message['kind'] => { const d = decodeMessage(encoded); if (!d.ok) throw new Error(d.error.message); return d.message.kind; };
/** Decode a sent carrier request or fail the test. */
const packetOf = (sent: string | undefined) => { const r = decodeCarrierRequest(sent); if (!r.ok) throw new Error(r.error.message); return r.packet; };
const discoverOf = (encoded: string) => { const d = decodeMessage(encoded); if (!d.ok || d.message.kind !== 'discover') throw new Error('expected discover'); return d.message; };

const OWNER = fixtureTarget.ownerId;
const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION } as const;
const receipt = (n: number) => `${n}.${'ab'.repeat(16)}`;

function harness(options: Partial<ConstructorParameters<typeof HostCore>[1]> = {}) {
  const sent: string[] = [];
  const frames: string[] = [];
  const states: HostState[] = [];
  const exports: { recordingId: string; exportId: string; text: string; bytes: number }[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const core = new HostCore({
    send: p => sent.push(p),
    frame: f => frames.push(f),
    state: s => states.push(s),
    exported: r => exports.push(r),
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
  }, { ownerId: OWNER, ...options });
  /** The last carrier request the owner sent, decoded. */
  const last = () => { const r = decodeCarrierRequest(sent.at(-1)); if (!r.ok) throw new Error(r.error.message); return r.packet; };
  /** The inner protocol message of the last request. */
  const lastMessage = () => { const p = last(); if (p.kind !== 'request') throw new Error(`last was ${p.kind}`); const d = decodeMessage(p.message); if (!d.ok) throw new Error(d.error.message); return d.message; };
  const fire = (pick: (t: { ms: number }) => boolean) => { const t = timers.filter(t => t.live).find(pick); if (!t) throw new Error('no such timer'); t.live = false; t.fn(); };
  const reply = (n: number, messages: Message[], generation = core.state.generation) =>
    core.receive(encodeCarrierReply({ kind: 'reply', receipt: receipt(n), frames: messages.map(m => encodeMessage(m)) }), generation);
  const hello = (requestId: string) => ({ ...common, kind: 'hello', requestId, ownerId: OWNER, sources: [fixtureSource] }) as const;
  return { core, sent, frames, states, exports, timers, last, lastMessage, fire, reply, hello };
}

/** Bootstrap, hello, select the fixture source, snapshot: the attached steady state. */
function attached() {
  const h = harness();
  const discover = decodeMessage(h.core.bootstrap());
  if (!discover.ok || discover.message.kind !== 'discover') throw new Error('bootstrap must yield discover');
  h.reply(1, [h.hello(discover.message.requestId)]);
  expect(h.core.attach(fixtureSource.sourceId, fixtureSource.runId)).toBe(true);
  const attach = h.lastMessage();
  if (attach.kind !== 'attach') throw new Error('expected attach');
  h.reply(2, [{ ...snapshotFixture, requestId: attach.requestId, target: fixtureTarget }]);
  return { ...h, attachRequestId: attach.requestId };
}

describe('bootstrap and credit', () => {
  it('mints a discover, treats hello as the end of the bootstrap exchange and schedules an idle poll', () => {
    const h = harness();
    const discover = discoverOf(h.core.bootstrap());
    expect(discover.ownerId).toBe(OWNER);
    expect(h.core.state).toMatchObject({ phase: 'bootstrapping', generation: 1, inFlight: true });
    expect(h.sent).toEqual([]);                       // the relay carries the discover; nothing else is sent yet
    h.reply(1, [h.hello(discover.requestId)]);
    expect(h.core.state).toMatchObject({ phase: 'discovered', inFlight: false });
    expect(h.core.state.sources.map(s => s.sourceId)).toEqual([fixtureSource.sourceId]);
    expect(h.frames).toHaveLength(1);
    expect(h.timers.filter(t => t.live).map(t => t.ms)).toEqual([2000]);   // idle poll, reply timeout cancelled
    h.fire(t => t.ms === 2000);
    expect(h.last()).toEqual({ kind: 'poll', receipt: receipt(1) });
    expect(h.core.state.inFlight).toBe(true);
  });

  it('echoes each receipt exactly once and an empty poll still refreshes the credit', () => {
    const h = attached();
    h.fire(t => t.ms === 250);
    expect(h.last()).toEqual({ kind: 'poll', receipt: receipt(2) });
    h.reply(3, []);
    h.fire(t => t.ms === 250);
    expect(h.last()).toEqual({ kind: 'poll', receipt: receipt(3) });
    const receipts = h.sent.map(p => { const k = packetOf(p); return k.kind === 'close' ? null : k.receipt; });
    expect(new Set(receipts).size).toBe(receipts.length);
  });

  it('lets a queued command take the held credit instead of the scheduled poll', () => {
    const h = attached();
    const before = h.sent.length;
    expect(h.core.refresh()).toBe(true);
    expect(h.sent).toHaveLength(before + 1);
    expect(h.lastMessage()).toMatchObject({ kind: 'snapshot.request', target: fixtureTarget, scope: { kind: 'source' } });
    expect(h.timers.filter(t => t.live && t.ms === 250)).toHaveLength(0);    // the poll yielded
    // A second command waits: one exchange in flight.
    expect(h.core.refresh({ kind: 'delivery', deliveryId: 'delivery-2' })).toBe(true);
    expect(h.sent).toHaveLength(before + 1);
    expect(h.core.state.queued).toBe(1);
  });

  it('bounds the command queue and refuses commands before hello', () => {
    const h = harness();
    h.core.bootstrap();
    expect(h.core.rediscover()).toBe(false);          // bootstrapping: nothing may be queued yet
    const a = attached();
    a.core.refresh();                                 // in flight
    expect(a.core.refresh()).toBe(false);             // a second whole-source refresh coalesces into the pending one
    for (let i = 0; i < 8; i++) expect(a.core.refresh({ kind: 'delivery', deliveryId: `d-${i}` })).toBe(true);
    expect(a.core.refresh({ kind: 'delivery', deliveryId: 'd-9' })).toBe(false);
    expect(a.core.state.queued).toBe(8);
  });
});

describe('correlation', () => {
  it('binds the attach snapshot to the pending attach and forwards frames in order', () => {
    const h = attached();
    expect(h.core.state).toMatchObject({ phase: 'attached', target: fixtureTarget });
    expect(h.frames.map(kindOf)).toEqual(['hello', 'snapshot']);
    h.fire(t => t.ms === 250);
    h.reply(3, [batchFixture]);
    expect(h.frames.map(kindOf)).toEqual(['hello', 'snapshot', 'batch']);
  });

  it('recognises the delayed withdrawal notice by the attach pair and keeps the carrier open', () => {
    const h = attached();
    h.fire(t => t.ms === 250);
    h.reply(3, [{ ...common, kind: 'error', requestId: h.attachRequestId, target: fixtureTarget, code: 'not-found', message: 'Diagnostic source was withdrawn' }]);
    expect(h.core.state).toMatchObject({ phase: 'withdrawn', target: null });
    expect(h.core.state.reason).toContain('not-found');
    // Idempotent: the same notice again changes nothing and is not a violation.
    h.fire(t => t.ms === 2000);
    h.reply(4, [{ ...common, kind: 'error', requestId: h.attachRequestId, target: fixtureTarget, code: 'not-found', message: 'again' }]);
    expect(h.core.state.phase).toBe('withdrawn');
    expect(h.sent.some(p => packetOf(p).kind === 'close')).toBe(false);
    // The carrier is still usable: a new attach is allowed.
    expect(h.core.attach(fixtureSource.sourceId, fixtureSource.runId)).toBe(true);
  });

  it('treats an unsolicited error as a protocol violation and closes the carrier', () => {
    const h = attached();
    h.fire(t => t.ms === 250);
    h.reply(3, [{ ...common, kind: 'error', requestId: 'never-sent', target: null, code: 'internal', message: 'x' }]);
    expect(h.core.state.phase).toBe('closed');
    expect(h.core.state.reason).toContain('protocol-violation');
    expect(h.last()).toEqual({ kind: 'close' });
    expect(h.frames.map(kindOf)).not.toContain('error');
  });

  it('refuses a batch for an attachment this owner does not hold', () => {
    const h = attached();
    h.fire(t => t.ms === 250);
    h.reply(3, [{ ...batchFixture, target: { ...fixtureTarget, attachmentId: 'someone-else' } }]);
    expect(h.core.state.phase).toBe('closed');
    expect(h.frames).toHaveLength(2);
  });

  it('completes detach on ack and returns to discovered; a replacement attach waits for that ack', () => {
    const h = attached();
    expect(h.core.detach()).toBe(true);
    expect(h.core.attach('next-source', 'next-run')).toBe(false);     // the lease is still held until the ack
    const detach = h.lastMessage();
    if (detach.kind !== 'detach') throw new Error('expected detach');
    h.reply(3, [{ ...common, kind: 'ack', requestId: detach.requestId, target: fixtureTarget }]);
    expect(h.core.state).toMatchObject({ phase: 'discovered', target: null });
    expect(h.core.refresh()).toBe(false);
    expect(h.core.attach('next-source', 'next-run')).toBe(true);      // released by the ack
  });

  it('records a refused attach without closing the carrier', () => {
    const h = harness();
    const d = discoverOf(h.core.bootstrap());
    h.reply(1, [h.hello(d.requestId)]);
    h.core.attach('missing', 'run');
    const attach = h.lastMessage();
    if (attach.kind !== 'attach') throw new Error('expected attach');
    h.reply(2, [{ ...common, kind: 'error', requestId: attach.requestId, target: null, code: 'not-found', message: 'Diagnostic source is not registered' }]);
    expect(h.core.state).toMatchObject({ phase: 'discovered', lastError: { command: 'attach', code: 'not-found' } });
  });
});

describe('terminal outcomes', () => {
  it('reports a terminal closed packet with the registry reason and sends nothing more', () => {
    const h = attached();
    h.fire(t => t.ms === 250);
    const before = h.sent.length;
    h.core.receive(encodeCarrierReply({ kind: 'closed', reason: 'registry-closed', connectionReason: 'invalid-message' }), h.core.state.generation);
    expect(h.core.state).toMatchObject({ phase: 'closed', reason: 'registry-closed · invalid-message' });
    expect(h.core.refresh()).toBe(false);
    expect(h.sent).toHaveLength(before);
    expect(h.timers.filter(t => t.live)).toHaveLength(0);
  });

  it('shows idle-timeout as the observed expiry, not as an owner fault', () => {
    const h = attached();
    h.core.receive(encodeCarrierReply({ kind: 'closed', reason: 'idle-timeout', connectionReason: null }), 1);
    expect(h.core.state).toMatchObject({ phase: 'closed', reason: 'idle-timeout' });
  });

  it('marks a silent page lost after the owner timeout and a port loss as lost without a reason guess', () => {
    const h = attached();
    h.fire(t => t.ms === 250);
    h.fire(t => t.ms === 5000);
    expect(h.core.state).toMatchObject({ phase: 'lost', reason: 'no reply within 5000 ms' });
    const g = harness(); g.core.bootstrap(); g.core.lost('port disconnected');
    expect(g.core.state).toMatchObject({ phase: 'lost', reason: 'port disconnected' });
  });

  it('ignores packets from an older generation and starts the new one clean', () => {
    const h = attached();
    const stale = h.core.state.generation;
    h.core.bootstrap();
    expect(h.core.state).toMatchObject({ phase: 'bootstrapping', generation: stale + 1, target: null, sources: [] });
    h.reply(9, [batchFixture], stale);                // old channel's packet
    expect(h.core.state.phase).toBe('bootstrapping');
    expect(h.frames).toHaveLength(2);                 // nothing forwarded from the stale generation
  });

  it('owner close sends the receipt-free close once and rejects an undecodable packet as a violation', () => {
    const h = attached();
    expect(decodeCarrierRequest(h.core.close()!)).toMatchObject({ ok: true, packet: { kind: 'close' } });
    expect(h.core.close()).toBeNull();
    const g = attached();
    g.core.receive('not json', g.core.state.generation);
    expect(g.core.state.phase).toBe('closed');
    expect(g.core.state.reason).toContain('invalid carrier packet');
  });
});

describe('exchange completion and strict correlation', () => {
  /** Bootstrap + hello + attach, with an optional change to the attach snapshot. */
  function bound(change: Partial<Snapshot> = {}) {
    const h = harness();
    const d = decodeMessage(h.core.bootstrap());
    if (!d.ok || d.message.kind !== 'discover') throw new Error('expected discover');
    h.reply(1, [h.hello(d.message.requestId)]);
    expect(h.core.attach(fixtureSource.sourceId, fixtureSource.runId)).toBe(true);
    const a = h.lastMessage(); if (a.kind !== 'attach') throw new Error('expected attach');
    h.reply(2, [{ ...snapshotFixture, requestId: a.requestId, ...change }]);
    return { ...h, attachRequestId: a.requestId };
  }
  const closed = (h: ReturnType<typeof harness>) => {
    expect(h.core.state.phase).toBe('closed');
    expect(decodeCarrierRequest(h.sent.at(-1))).toMatchObject({ ok: true, packet: { kind: 'close' } });
  };
  const requestId = (m: Message): string => ('requestId' in m ? m.requestId : '');

  it.each(['sourceId', 'runId'] as const)('refuses an attach snapshot for a different requested %s', field => {
    const h = bound({ target: { ...fixtureTarget, [field]: 'different' }, source: { ...fixtureSource, [field]: 'different' } });
    closed(h); expect(h.frames).toHaveLength(1);
  });

  it('refuses a detail reply to a whole-source refresh', () => {
    const h = bound(); h.core.refresh(); const q = h.lastMessage();
    h.reply(3, [{ ...snapshotFixture, requestId: requestId(q), scope: { kind: 'delivery', deliveryId: 'unrequested' } }]);
    closed(h); expect(h.frames).toHaveLength(2);
  });

  it('refuses a refresh error naming a different attachment', () => {
    const h = bound(); h.core.refresh(); const q = h.lastMessage();
    h.reply(3, [{ ...common, kind: 'error', requestId: requestId(q), target: { ...fixtureTarget, attachmentId: 'another' }, code: 'not-found', message: 'other' }]);
    closed(h); expect(h.frames).toHaveLength(2);
  });

  it('treats only not-found on the attach pair as withdrawal; another code there is a violation', () => {
    const h = bound(); h.fire(t => t.ms === 250);
    h.reply(3, [{ ...common, kind: 'error', requestId: h.attachRequestId, target: fixtureTarget, code: 'internal', message: 'not a withdrawal' }]);
    closed(h); expect(h.frames).toHaveLength(2);
  });

  it('refuses a carrier data reply when no exchange is outstanding', () => {
    const h = bound(); expect(h.core.state.inFlight).toBe(false);
    h.reply(3, []); closed(h);
  });

  it('does not let an empty bootstrap reply pass as a completed discovery', () => {
    const h = harness(); h.core.bootstrap(); h.reply(1, []); closed(h);
  });

  it('requires the refresh outcome in its exchange even when a pending batch was delivered', () => {
    const h = bound(); h.core.refresh(); h.reply(3, [batchFixture]); closed(h);
    // The valid two-frame shape still works: pending batch, then the requested snapshot.
    const g = bound(); g.core.refresh(); const q = g.lastMessage();
    g.reply(3, [batchFixture, { ...snapshotFixture, requestId: requestId(q), watermark: '6' }]);
    expect(g.core.state.phase).toBe('attached'); expect(g.frames).toHaveLength(4);
  });

  it('requires the rediscover outcome before the next exchange', () => {
    const h = bound(); h.core.rediscover(); h.reply(3, []); closed(h);
  });

  it('refuses unsolicited recording frames since recording is not implemented', () => {
    const h = bound(); h.fire(t => t.ms === 250);
    h.reply(3, [{ ...common, kind: 'record.started', requestId: 'never', target: fixtureTarget, recordingId: 'rec-1', token: 'tok' }]);
    closed(h);
  });

  it('actively releases a silent carrier on the owner timeout: close is sent and the phase is lost', () => {
    const h = bound(); h.fire(t => t.ms === 250); h.fire(t => t.ms === 5000);
    expect(h.core.state.phase).toBe('lost');
    expect(decodeCarrierRequest(h.sent.at(-1))).toMatchObject({ ok: true, packet: { kind: 'close' } });
  });

  it('accepts a terminal closed packet after the one data reply, with no exchange outstanding', () => {
    const h = bound();
    h.core.receive(encodeCarrierReply({ kind: 'closed', reason: 'page-hidden', connectionReason: null }), h.core.state.generation);
    expect(h.core.state).toMatchObject({ phase: 'closed', reason: 'page-hidden' });
  });
});

describe('recording held by the owner', () => {
  const REC = { recordingId: 'rec-1', token: 'tok-secret' } as const;
  const chunk = (requestId: string, index: number, data: string, final: boolean, exportId = 'exp-1') =>
    ({ ...common, kind: 'export.chunk', requestId, target: fixtureTarget, exportId, index, final, data }) as const;
  /** Attached, recording started: the owner holds id + token. */
  function recording() {
    const h = attached();
    expect(h.core.recordStart()).toBe(true);
    const start = h.lastMessage(); if (start.kind !== 'record.start') throw new Error('expected record.start');
    h.reply(3, [{ ...common, kind: 'record.started', requestId: start.requestId, target: fixtureTarget, ...REC }]);
    return h;
  }

  it('starts a recording, keeps the token out of every forwarded frame and state, and refuses a second start', () => {
    const h = recording();
    expect(h.core.state.recording).toEqual({ recordingId: 'rec-1', exporting: null });
    expect(JSON.stringify(h.states)).not.toContain('tok-secret');
    expect(h.frames.map(kindOf)).not.toContain('record.started');
    expect(h.core.recordStart()).toBe(false);
  });

  it('stops with the held token and keeps the stopped recording exportable', () => {
    const h = recording();
    expect(h.core.recordStop()).toBe(true);
    const stop = h.lastMessage(); if (stop.kind !== 'record.stop') throw new Error('expected record.stop');
    expect(stop).toMatchObject({ recordingId: 'rec-1', token: 'tok-secret', target: fixtureTarget });
    h.reply(4, [{ ...common, kind: 'ack', requestId: stop.requestId, target: fixtureTarget }]);
    expect(h.core.state).toMatchObject({ phase: 'attached', recording: { recordingId: 'rec-1' } });
    expect(h.core.recordExport()).toBe(true);
  });

  it('reassembles an export across the request exchange and later polls, yielding credit at once in between', () => {
    const h = recording();
    expect(h.core.recordExport()).toBe(true);
    const ex = h.lastMessage(); if (ex.kind !== 'record.export') throw new Error('expected record.export');
    h.reply(4, [chunk(ex.requestId, 0, 'ab', false)]);
    expect(h.core.state.recording?.exporting).toEqual({ chunks: 1, bytes: 2 });
    expect(h.timers.filter(t => t.live).map(t => t.ms)).toEqual([60000, 0]);   // export deadline + immediate poll
    h.fire(t => t.ms === 0);
    expect(h.last().kind).toBe('poll');
    h.reply(5, [batchFixture, chunk(ex.requestId, 1, 'c\u00e9', false)]);        // a live batch may interleave
    h.fire(t => t.ms === 0);
    h.reply(6, [chunk(ex.requestId, 2, 'd', true)]);
    expect(h.exports).toEqual([{ recordingId: 'rec-1', exportId: 'exp-1', text: 'abc\u00e9d', bytes: 6 }]);
    expect(h.core.state.recording).toEqual({ recordingId: 'rec-1', exporting: null });
    expect(h.timers.filter(t => t.live).map(t => t.ms)).toEqual([250]);           // back to the observation cadence
    expect(h.frames.map(kindOf)).not.toContain('export.chunk');
    expect(h.core.recordExport()).toBe(true);                                      // a new export may start now
  });

  it('refuses a second export while one is incomplete; a chunk gap is the page\'s fault', () => {
    const h = recording();
    h.core.recordExport(); const ex = h.lastMessage(); if (ex.kind !== 'record.export') throw new Error('x');
    h.reply(4, [chunk(ex.requestId, 0, 'a', false)]);
    expect(h.core.recordExport()).toBe(false);
    h.fire(t => t.ms === 0);
    h.reply(5, [chunk(ex.requestId, 2, 'gap', false)]);                            // index 1 skipped
    expect(h.core.state.phase).toBe('closed');
    expect(h.core.state.reason).toContain('protocol-violation');
    expect(packetOf(h.sent.at(-1)).kind).toBe('close');
  });

  it('a page error on the export drops only that export and keeps the lease', () => {
    const h = recording();
    h.core.recordExport(); const ex = h.lastMessage(); if (ex.kind !== 'record.export') throw new Error('x');
    h.reply(4, [{ ...common, kind: 'error', requestId: ex.requestId, target: fixtureTarget, code: 'limit', message: 'too big' }]);
    expect(h.core.state).toMatchObject({ phase: 'attached', recording: { recordingId: 'rec-1', exporting: null }, lastError: { command: 'record.export', code: 'aborted' } });
    expect(h.core.recordExport()).toBe(true);
  });

  it('our byte budget closes the carrier as local policy, and the page\'s later valid chunk is not blamed on it', () => {
    const h = recordingOn(harness({ exportMaxBytes: 3 }));
    h.core.recordExport(); const ex = h.lastMessage(); if (ex.kind !== 'record.export') throw new Error('x');
    h.reply(4, [chunk(ex.requestId, 0, 'abcd', false)]);
    expect(h.core.state.phase).toBe('closed');
    expect(h.core.state.reason).toMatch(/^local-policy · export exceeded/);
    expect(packetOf(h.sent.at(-1)).kind).toBe('close');
    expect(h.exports).toHaveLength(0);
    const sent = h.sent.length, states = h.states.length;
    h.reply(5, [chunk(ex.requestId, 1, 'e', true)]);                               // the page continues; we are gone
    expect(h.core.state.reason).not.toContain('protocol-violation');
    expect(h.sent).toHaveLength(sent); expect(h.states).toHaveLength(states);
  });

  it('our deadline closes the carrier as local policy, and a late chunk afterwards changes nothing', () => {
    const h = recording(); h.core.recordExport(); const ex = h.lastMessage(); if (ex.kind !== 'record.export') throw new Error('x');
    h.reply(4, [chunk(ex.requestId, 0, 'a', false)]);
    h.fire(t => t.ms === 60000);
    expect(h.core.state).toMatchObject({ phase: 'closed' });
    expect(h.core.state.reason).toMatch(/^local-policy · export did not complete/);
    expect(packetOf(h.sent.at(-1)).kind).toBe('close');
    h.reply(5, [chunk(ex.requestId, 1, 'b', true)]);
    expect(h.core.state.reason).not.toContain('protocol-violation');
  });

  it('releases the recording and aborts an export on detach, withdrawal and terminal states', () => {
    const h = recording(); h.core.recordExport(); const ex = h.lastMessage(); if (ex.kind !== 'record.export') throw new Error('x');
    h.reply(4, [chunk(ex.requestId, 0, 'a', false)]);
    h.core.detach(); const dt = h.lastMessage(); if (dt.kind !== 'detach') throw new Error('x');
    h.reply(5, [{ ...common, kind: 'ack', requestId: dt.requestId, target: fixtureTarget }]);
    expect(h.core.state.recording).toBeNull();
    const w = recording(); w.fire(t => t.ms === 250);
    w.reply(4, [{ ...common, kind: 'error', requestId: w.attachRequestId, target: fixtureTarget, code: 'not-found', message: 'withdrawn' }]);
    expect(w.core.state).toMatchObject({ phase: 'withdrawn', recording: null });
    const t = recording(); t.core.lost('port gone');
    expect(t.core.state.recording).toBeNull();
  });

  it('treats a chunk for an unknown export or a started reply without a start as violations', () => {
    const h = recording(); h.fire(t => t.ms === 250);
    h.reply(4, [chunk('never', 0, 'x', true)]);
    expect(h.core.state.phase).toBe('closed');
    const g = attached(); g.fire(t => t.ms === 250);
    g.reply(3, [{ ...common, kind: 'record.started', requestId: 'never', target: fixtureTarget, ...REC }]);
    expect(g.core.state.phase).toBe('closed');
  });

  /** Like `recording()` but on a harness constructed with custom options. */
  function recordingOn(h: ReturnType<typeof harness>) {
    const discover = discoverOf(h.core.bootstrap());
    h.reply(1, [h.hello(discover.requestId)]);
    h.core.attach(fixtureSource.sourceId, fixtureSource.runId);
    const a = h.lastMessage(); if (a.kind !== 'attach') throw new Error('expected attach');
    h.reply(2, [{ ...snapshotFixture, requestId: a.requestId, target: fixtureTarget }]);
    h.core.recordStart(); const st = h.lastMessage(); if (st.kind !== 'record.start') throw new Error('x');
    h.reply(3, [{ ...common, kind: 'record.started', requestId: st.requestId, target: fixtureTarget, ...REC }]);
    return h;
  }
});
