// Issue #52 (publisher restart) — liveness restart ladder measured through the public
// MoqtPlayer against a real SDK server peer over the loopback transport, drafts 18/22.
// Spec (16 §REQUEST_ERROR, 18 §10.6, 22 §9.4, identical text): "Retry Interval: the
// minimum time (ms) before the request SHOULD be sent again, plus one. 0: the request
// SHOULD NOT be retried. 1: can be retried immediately." Drafts 16/18 §5.1: one
// publisher-role subscription per Track (DUPLICATE_SUBSCRIPTION); §5.1.1: the publisher
// can destroy subscription state as soon as it has RECEIVED STOP_SENDING.
// Single-byte objects prove routing/liveness accounting only, not rendered playback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlCodec, varint, RequestError, type ControlMessage } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import type { PlayerError } from './errors.js';
import { MoqtPlayer } from './player.js';
import { videoInit } from '../../locmaf/test-support/cmaf.js';
import type { MediaSourceLike, AudioDecoderLike, AudioOutputLike } from './interfaces.js';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';

const decoder = new TextDecoder();
const LIVENESS = { livenessTimeoutMs: 50, livenessResetProbeMs: 40, livenessRestartBackoffMs: 5, livenessMaxRestarts: 5, livenessHealthyResetMs: 10_000 };

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] }));
afterEach(() => vi.useRealTimers());

type Ev = { t: number; kind: string; detail?: string };
type Req = { id: bigint; ns: string[]; name: string; t: number };
type Ctrl = ReadableStreamDefaultController<Uint8Array>;

type Draft = 14 | 16 | 18 | 22;
async function playing(draft: Draft, options: { holdNextRequestWrite?: boolean; audio?: boolean; config?: Record<string, unknown> } = {}) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  // A GOAWAY starts a migration through createConnection/createTransport: give it a FRESH pair whose
  // transport is held (never served) — the intended unavailable-candidate control — instead of
  // reusing the established client/transport (which locks the already-read incoming stream).
  const candidate = { conn: new MoqtConnection(draft), loop: createLoopback(), server: new MoqtConnection(draft, { role: 'server' }), serving: undefined as Promise<void> | undefined };
  let releaseCandidate!: (transport: typeof a) => void;
  const heldCandidateTransport = new Promise<typeof a>(resolve => { releaseCandidate = resolve; });
  let connects = 0;
  const requests: Req[] = [], events: Ev[] = [];
  const now = () => Math.round(performance.now());
  const log = (kind: string, detail?: string) => { events.push({ t: now(), kind, ...(detail ? { detail } : {}) }); };
  const sub0 = () => server.session.getIncomingSubscription(0n)?.state ?? 'gone';
  server.onSubscribe = (id, ns, name) => {
    requests.push({ id, ns: ns.map(f => decoder.decode(f)), name: decoder.decode(name), t: now() });
    log('server:SUBSCRIBE', `${decoder.decode(name)} id=${id} sub0=${sub0()}`);
  };
  server.onSubscribeClosed = id => log('server:subscription-closed', `id=${id}`);
  server.onMessage = msg => { if (msg.type === 'REQUEST_UPDATE') log('server:REQUEST_UPDATE', `id=${(msg as { requestId: bigint }).requestId}`); };
  // The SDK server session answers a duplicate-track SUBSCRIBE itself (drafts 16/18 §5.1) before onSubscribe.
  // Inspect retained session output (private method, same convention as other loopback suites inspecting retained state).
  type SessionOut = { sendControl(msg: ControlMessage): unknown };
  const session = server.session as unknown as SessionOut;
  const sessionSend = session.sendControl.bind(session);
  vi.spyOn(session, 'sendControl').mockImplementation((msg: ControlMessage) => {
    if (msg.type === 'REQUEST_ERROR') log('server-session:REQUEST_ERROR', `id=${msg.requestId} code=0x${BigInt(msg.errorCode).toString(16)} sub0=${sub0()}`);
    return sessionSend(msg);
  });
  // Optional transport ordering control: buffer the NEXT request stream's bytes (the
  // replacement SUBSCRIBE) until released, so the old stream's RESET is processed first.
  let heldOut: { releaseHeld(): void; faults: { hold?: boolean } } | null = null;
  if (options.holdNextRequestWrite) {
    const open = a.createBidirectionalStream.bind(a);
    vi.spyOn(a, 'createBidirectionalStream').mockImplementation(async () => {
      const view = await open(); const entry = a.bidiOut.at(-1)!;
      if (heldOut === null && a.bidiOut.length > 1) { entry.out.faults.hold = true; heldOut = entry.out; log('transport:hold-replacement-write'); }
      return view;
    });
  }
  let connected: Promise<void> | undefined;
  const audioDecoder: AudioDecoderLike = { configure: vi.fn(), flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onData: null, onError: null, decode: vi.fn() };
  const audioOutput: AudioOutputLike = { flush() {}, destroy() {}, currentPlayoutTimeUs: 0, schedule: vi.fn() };
  const errors: PlayerError[] = [], arrivals: number[] = [], recovery: Array<{ t: number; attempt: number }> = [];
  const player = new MoqtPlayer({
    url: 'https://relay.invalid/moq', namespace: 'live', draftVersion: draft,
    createConnection: () => ++connects === 1 ? client : candidate.conn,
    createTransport: async () => { if (connects === 1) { connected = server.connect(b, draft < 18 ? { maxRequestId: varint(1000n) } : {}); void connected.catch(() => {}); return a; } return heldCandidateTransport; },
    catalog: { version: 1, tracks: [
      { name: 'video', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', width: 10, height: 10, renderGroup: 1, altGroup: 1, bitrate: 200 },
      { name: 'video2', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', width: 10, height: 10, renderGroup: 1, altGroup: 1, bitrate: 100 },
      ...(options.audio ? [{ name: 'audio', role: 'audio' as const, packaging: 'loc' as const, isLive: true, codec: 'opus', samplerate: 48000, channelConfig: '2', renderGroup: 1 }] : []),
    ] },
    selection: { videoTrack: { name: 'video' }, ...(options.audio ? { audioTrack: { name: 'audio' } } : {}) },
    ...(options.audio ? { createAudioDecoder: () => audioDecoder, createAudioOutput: () => audioOutput, disableAudio: false } : { disableAudio: true }),
    autoQuality: false, connectionTimeoutMs: 5000, ...LIVENESS, ...(options.config ?? {}),
  });
  player.on('error', e => { errors.push(e.error); log('player:error', `${e.error.code} ${e.error.severity} ${e.error.message}`); });
  player.on('media_object', e => { if (e.mediaType === 'video') arrivals.push(now()); log('player:media_object', e.mediaType); });
  player.on('recovery_action', e => { if (e.action.type === 'track_restart') { if (e.action.mediaType === 'video') recovery.push({ t: now(), attempt: e.action.attempt }); log('player:track_restart', `${e.action.mediaType} attempt=${e.action.attempt}`); } });
  player.on('track_subscribed', e => log('player:track_subscribed', `id=${e.requestId}`));
  player.on('track_subscribe_failed', e => log('player:track_subscribe_failed', `id=${e.requestId} code=0x${e.errorCode.toString(16)}`));
  const codec = createControlCodec(draft);
  await player.load(); await flush(128);
  expect(requests.map(r => r.name).sort()).toEqual(options.audio ? ['audio', 'video'] : ['video']);
  await server.acceptSubscribe(requests.find(r => r.name === 'video')!.id, 50n);
  if (options.audio) await server.acceptSubscribe(requests.find(r => r.name === 'audio')!.id, 51n);
  await flush(128); player.play();
  const stream = await server.openSubgroup(50n, 0n, 0n);
  await server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
  let audioStream: Awaited<ReturnType<typeof server.openSubgroup>> | null = null;
  if (options.audio) { audioStream = await server.openSubgroup(51n, 0n, 0n); await server.sendObject(audioStream, 0n, Uint8Array.of(9)); await flush(128); }
  player.tick();
  expect(arrivals).toHaveLength(1); expect(player.state).toBe('playing');
  if (draft >= 18) server.setLargestLocationProvider(() => ({ group: 0n, object: 0n }));
  const lastObjectAt = now();
  const identity = (r: Req) => r.name === 'video' && r.ns.join('/') === 'live';
  const f = {
    player, server, client, a, requests, events, errors, arrivals, recovery, lastObjectAt, now, log,
    async run(ms: number) { for (let i = 0; i < ms; i += 5) { await vi.advanceTimersByTimeAsync(5); await flush(16); } },
    releaseHeldWrite() { if (!heldOut) throw new Error('nothing held'); heldOut.faults.hold = false; heldOut.releaseHeld(); log('transport:release-replacement-write'); },
    /** Defer delivery of request stream #idx's RESET (client writer.abort) to the server until releaseReset(). */
    holdReset(idx: number) {
      const pipe = a.bidiOut[idx]!.out as unknown as { ctrl: Ctrl };
      const ctrl = pipe.ctrl; let pending: (() => void) | null = null;
      pipe.ctrl = { enqueue: c => ctrl.enqueue(c), close: () => ctrl.close(), error: (e: unknown) => { pending = () => ctrl.error(e); log('transport:hold-reset', `stream#${idx}`); }, get desiredSize() { return ctrl.desiredSize; } } as Ctrl;
      return () => { if (pending) { log('transport:release-reset', `stream#${idx}`); pending(); pending = null; } };
    },
    /** Refuse request `id` from the server application with an explicit Retry Interval (SDK rejectSubscribe takes none). */
    async refuse(id: bigint, retryInterval: bigint) {
      // Drafts 18/22: REQUEST_ERROR carries NO Request ID on the wire — the response stream identifies the request.
      const bidi = f.requestStream(id);
      bidi.in.injectRead(codec.encode({ type: 'REQUEST_ERROR', requestId: varint(id), errorCode: RequestError.DOES_NOT_EXIST, retryInterval: varint(retryInterval), errorReason: 'publisher gone',
        ...(draft === 14 ? { requestKind: 'SUBSCRIBE' as const } : {}) } as ControlMessage));
      log('server:REQUEST_ERROR', `id=${id} retryInterval=${retryInterval} stream#${a.bidiOut.indexOf(bidi)}`); await flush(128);
    },
    async deliverOn(id: bigint, group: bigint) {
      await server.acceptSubscribe(id, 60n + group); await flush(64);
      const s = await server.openSubgroup(60n + group, group, 0n); await server.sendObject(s, 0n, Uint8Array.of(2)); await flush(128); player.tick();
      return s;
    },
    /** A returned publisher keeps publishing: one object per 20ms of fake time. */
    async keepDelivering(s: Awaited<ReturnType<typeof server.openSubgroup>>, ms: number) {
      for (let i = 1n; i <= BigInt(Math.ceil(ms / 20)); i++) { await f.run(20); await server.sendObject(s, i, Uint8Array.of(2)); await flush(32); }
    },
    /** Peer terminates the response half of request stream #idx (RESET_STREAM as the client's readable sees it). */
    peerResetRequestStream(idx: number) {
      const pipe = a.bidiOut[idx]!.in as unknown as { ctrl: Ctrl };
      pipe.ctrl.error(Object.assign(new Error('simulated peer RESET_STREAM'), { streamErrorCode: 0 }));
      log('transport:peer-reset-request-stream', `stream#${idx}`);
    },
    /** The first liveness replacement SUBSCRIBE the server APPLICATION saw (draft 18: attempt 3, after the §5.1 duplicate refusal of attempt 2). */
    async replacementSeen(maxMs = 400) {
      for (let i = 0; i < maxMs / 5; i++) { const seen = requests.find((r, idx) => idx > 0 && identity(r)); if (seen) return seen; await f.run(5); }
      throw new Error('no replacement SUBSCRIBE reached the server application\n' + f.timeline());
    },
    identitySubscribesAfter(id: bigint) { return requests.filter(r => identity(r) && r.id > id); },
    /** Same as replacementSeen but stepping the fake clock 1ms at a time, so the caller still sits in the attempt's own instant. */
    async replacementSeenSameInstant(maxMs = 400) {
      for (let i = 0; i < maxMs; i++) { const seen = requests.find((r, idx) => idx > 0 && identity(r)); if (seen) return seen; await vi.advanceTimersByTimeAsync(1); await flush(16); }
      throw new Error('no replacement SUBSCRIBE reached the server application\n' + f.timeline());
    },
    /** Keep the audio track healthy (its own ladder must never fire) while video starves. */
    async feedAudio(objectId: bigint) { if (!audioStream) throw new Error('no audio'); await server.sendObject(audioStream, objectId, Uint8Array.of(9)); await flush(32); },
    /** Request stream of a given client request id: each SUBSCRIBE opens one bidi stream whose first written bytes are that SUBSCRIBE (drafts 18/22). */
    requestStream(id: bigint) {
      if (draft < 18) return a.bidiOut[0]!; // drafts 14/16: responses travel on the control stream
      for (const bidi of a.bidiOut) {
        const first = bidi.out.written[0]; if (!first) continue;
        try { const { message } = codec.decode(first, 0); if (message.type === 'SUBSCRIBE' && BigInt((message as { requestId: bigint }).requestId) === id) return bidi; } catch { /* not a control frame */ }
      }
      throw new Error(`no request stream carrying SUBSCRIBE ${id}`);
    },
    timeline() { return events.map(e => `+${e.t - lastObjectAt}ms ${e.kind}${e.detail ? ' ' + e.detail : ''}`).join('\n'); },
    async close() {
      const destroyed = player.destroy(); releaseCandidate(candidate.loop.a); await destroyed;
      await client.close(); await server.close(); await connected?.catch(() => {});
      await candidate.conn.close().catch(() => {}); await candidate.server.close().catch(() => {});
    },
    candidateConnects: () => connects,
  };
  return f;
}

describe.each([18, 22] as const)('issue #52 publisher return, draft %i', draft => {
  it('MEASURE: a publisher back right after attempt 1 is served by attempt 2 after the probe + backoff, with no wasted duplicate attempt', async () => {
    const f = await playing(draft);
    try {
      await f.run(70);
      expect(f.recovery.map(r => r.attempt)).toEqual([1]); expect(f.events.some(e => e.kind === 'server:REQUEST_UPDATE')).toBe(true);
      const publisherBackAt = f.now();
      const replacement = await f.replacementSeen(); await f.run(5); const live = await f.deliverOn(replacement.id, 1n);
      const delay = f.arrivals.at(-1)! - publisherBackAt;
      console.log(`[issue52 d${draft}] publisher-return→resume ${delay}ms\n` + f.timeline());
      // The publisher cannot be noticed before the probe of the unanswerable REQUEST_UPDATE ends.
      expect(delay).toBeGreaterThanOrEqual(LIVENESS.livenessTimeoutMs - 15);
      // Required: the first replacement SUBSCRIBE (attempt 2) is the one served, on both drafts — no wasted duplicate attempt.
      expect(f.recovery.map(r => r.attempt)).toEqual([1, 2]);
      expect(f.events.filter(e => e.kind === 'server-session:REQUEST_ERROR')).toEqual([]);
      expect(f.player.state).toBe('playing'); expect(f.errors.filter(e => e.severity === 'fatal')).toEqual([]);
      // Recovery must END the ladder: with the publisher back for good, no further attempt or fatal.
      await f.keepDelivering(live, 400);
      console.log(`[issue52 d${draft} after-recovery]\n` + f.timeline().split('\n').slice(-6).join('\n'));
      expect(f.recovery.map(r => r.attempt), 'ladder ended on recovery').toEqual([1, 2]);
      expect(f.errors.filter(e => e.severity === 'fatal')).toEqual([]); expect(f.player.state).toBe('playing');
    } finally { await f.close(); }
  });

  it('ORDERING: local cancellation of the old request precedes the replacement on the wire; in common order the publisher has closed sub 0 first', async () => {
    const f = await playing(draft);
    try {
      await f.run(70); await f.run(60); // attempt 2
      const closed = f.events.find(e => e.kind === 'server:subscription-closed' && e.detail === 'id=0');
      const subscribe2 = f.events.filter(e => e.kind === 'server:SUBSCRIBE')[1];
      console.log(`[issue52 d${draft} ordering]\n` + f.timeline());
      expect(closed, 'publisher processed the old request cancellation').toBeDefined();
      expect(subscribe2, 'replacement reached the publisher application').toBeDefined();
      expect(subscribe2!.detail).toContain('sub0=gone');
      expect(closed!.t).toBeLessThanOrEqual(subscribe2!.t);
      expect(f.events.filter(e => e.kind === 'server-session:REQUEST_ERROR')).toEqual([]);
    } finally { await f.close(); }
  });

  if (draft === 18) {
    it('ORDERING CAUSE: when the publisher processes the old stream RESET before the replacement SUBSCRIBE, attempt 2 is accepted', async () => {
      const f = await playing(draft, { holdNextRequestWrite: true });
      try {
        await f.run(70); await f.run(60);
        expect(f.events.some(e => e.kind === 'transport:hold-replacement-write')).toBe(true);
        expect(f.events.some(e => e.kind === 'server:subscription-closed' && e.detail === 'id=0'), 'RESET of request stream 0 processed').toBe(true);
        f.releaseHeldWrite(); await f.run(10);
        console.log(`[issue52 d18 ordering-cause]\n` + f.timeline());
        expect(f.events.filter(e => e.kind === 'server-session:REQUEST_ERROR')).toEqual([]);
        const seen = f.requests.filter((r, i) => i > 0 && r.name === 'video'); expect(seen).toHaveLength(1);
        expect(f.recovery.map(r => r.attempt)).toEqual([1, 2]);
      } finally { await f.close(); }
    });

    it('ORDERING LIMIT (negative): a RESET held by the transport makes the replacement a duplicate regardless of local sequencing; the Retry Interval 0 refusal is honored, not exempted', async () => {
      const f = await playing(draft);
      try {
        await f.run(70); const release = f.holdReset(0); await f.run(60);
        const dup = f.events.find(e => e.kind === 'server-session:REQUEST_ERROR' && e.detail?.includes('code=0x19'));
        expect(dup, 'DUPLICATE_SUBSCRIPTION while the RESET is held').toBeDefined();
        expect(f.events.some(e => e.kind === 'server:subscription-closed')).toBe(false);
        const refusedId = BigInt(/id=(\d+)/.exec(dup!.detail!)![1]!);
        release(); await f.run(400);
        expect(f.events.some(e => e.kind === 'server:subscription-closed' && e.detail === 'id=0')).toBe(true);
        console.log(`[issue52 d18 ordering-limit]\n` + f.timeline());
        // Not a required successful-retry: the duplicate carries Retry Interval 0, so no identical re-send.
        expect(f.identitySubscribesAfter(refusedId)).toEqual([]);
        expect(f.events.some(e => e.kind === 'player:track_subscribed' && e.detail === `id=${refusedId}`), 'no track_subscribed after the refusal retired the entry').toBe(false);
      } finally { await f.close(); }
    });
  }

  describe('Retry Interval on the replacement the server application actually refuses', () => {
    it('0: no automatic identical retry on this connection, persisting across later ticks and no fresh self-looping incident', async () => {
      const f = await playing(draft);
      try {
        await f.run(70); const rep = await f.replacementSeen(); await f.refuse(rep.id, 0n);
        const refusalSeen = f.events.some(e => e.kind === 'player:track_subscribe_failed' && e.detail?.includes(`id=${rep.id}`));
        if (!refusalSeen) console.log(`[issue52 d${draft} retry=0 refusal not observed]\n` + f.timeline());
        expect(refusalSeen).toBe(true);
        const restartsAtRefusal = f.recovery.length;
        await f.run(1000);
        console.log(`[issue52 d${draft} retry=0] identical retries after refusal: ${f.identitySubscribesAfter(rep.id).length}; restarts ${restartsAtRefusal}→${f.recovery.length}; fatal=${f.errors.some(e => e.severity === 'fatal')}\n` + f.timeline());
        expect(f.identitySubscribesAfter(rep.id).map(r => `+${r.t - f.lastObjectAt}ms id=${r.id}`), 'identical SUBSCRIBE after Retry Interval 0').toEqual([]);
        expect(f.recovery.length, 'no new restart incidents after a 0 refusal').toBe(restartsAtRefusal);
      } finally { await f.close(); }
    });

    it('10001: no identical SUBSCRIBE before 10000ms after the refusal, and a retry at or after the boundary', async () => {
      const f = await playing(draft);
      try {
        await f.run(70); const rep = await f.replacementSeen(); const refusedAt = f.now(); await f.refuse(rep.id, 10_001n);
        await f.run(9_990); expect(f.identitySubscribesAfter(rep.id).map(r => `+${r.t - refusedAt}ms`), 'SUBSCRIBE before the minimum').toEqual([]);
        await f.run(700);
        const after = f.identitySubscribesAfter(rep.id);
        console.log(`[issue52 d${draft} retry=10001] retries at ${after.map(r => `+${r.t - refusedAt}ms`).join(',') || 'none'}\n` + f.timeline().split('\n').slice(-8).join('\n'));
        expect(after.length, 'retry at/after the boundary').toBeGreaterThanOrEqual(1);
        expect(after[0]!.t - refusedAt).toBeGreaterThanOrEqual(10_000);
      } finally { await f.close(); }
    });

    it('1: the retry does not consume the remaining media probe; it follows the recovery backoff policy only', async () => {
      const f = await playing(draft);
      try {
        await f.run(70); const rep = await f.replacementSeen(); const refusedAt = f.now(); await f.refuse(rep.id, 1n);
        let retry: Req | undefined;
        for (let i = 0; i < 40 && !retry; i++) { await f.run(5); retry = f.identitySubscribesAfter(rep.id)[0]; }
        const delay = retry ? retry.t - refusedAt : Infinity;
        const attemptIndex = f.recovery.length; // next backoff = base * 2^(attempt-1)
        const policyBackoff = LIVENESS.livenessRestartBackoffMs * 2 ** Math.max(0, attemptIndex - 1);
        console.log(`[issue52 d${draft} retry=1] retry delay ${delay}ms, policy backoff ${policyBackoff}ms, remaining probe would be ~${LIVENESS.livenessTimeoutMs - 11}ms\n` + f.timeline());
        expect(retry).toBeDefined();
        expect(delay, 'retry waited for the probe to expire instead of the backoff').toBeLessThanOrEqual(policyBackoff + 10);
        await f.deliverOn(retry!.id, 2n); expect(f.arrivals).toHaveLength(2); expect(f.player.state).toBe('playing');
      } finally { await f.close(); }
    });

    it('a refusal of a DIFFERENT live request (audio) binds only its own recovery; the video probe and replacement are unaffected', async () => {
      // Drafts 18/22 REQUEST_ERROR has no Request ID on the wire, so "foreign id on the same stream"
      // was an own-request refusal. The separate request is a real second media track with its own
      // request stream, starved at the same time so both ladders run.
      const f = await playing(draft, { audio: true });
      try {
        await f.run(70);
        expect(f.recovery.map(r => r.attempt)).toEqual([1]);
        const videoRep = await f.replacementSeen();
        const audioRep = f.requests.find((r, i) => i > 1 && r.name === 'audio');
        expect(audioRep, 'audio ladder also issued a replacement').toBeDefined();
        const t0 = f.now();
        await f.refuse(audioRep!.id, 10_001n); // audio's OWN refusal with a long minimum; its ladder must wait, video's must not notice
        expect(f.events.some(e => e.kind === 'player:track_subscribe_failed' && e.detail?.includes(`id=${audioRep!.id}`))).toBe(true);
        await f.run(20);
        const videoEarly = f.identitySubscribesAfter(videoRep.id).filter(r => r.t - t0 < LIVENESS.livenessTimeoutMs - 15);
        console.log(`[issue52 d${draft} other-request] audio refused at +${t0 - f.lastObjectAt}ms; early video identity SUBSCRIBEs: ${videoEarly.length}\n` + f.timeline());
        expect(videoEarly, 'video probe ended by the audio request\'s error').toEqual([]);
        // The video replacement is still live: serving it recovers video.
        const live = await f.deliverOn(videoRep.id, 1n); expect(f.arrivals).toHaveLength(2);
        // Audio identity must not be re-sent before its own minimum; the video recovery did not end audio's wait either.
        await f.keepDelivering(live, 300);
        console.log(`[issue52 d${draft} other-request end]\n` + f.timeline().split('\n').slice(-10).join('\n'));
        expect(f.requests.filter(r => r.name === 'audio' && r.id > audioRep!.id).map(r => `+${r.t - t0}ms`), 'audio re-sent before its Retry Interval minimum').toEqual([]);
        expect(f.player.state).toBe('playing');
      } finally { await f.close(); }
    });

    for (const control of ['pause', 'destroy', 'goaway', 'select-other'] as const) {
      it(`${control} during the post-refusal wait: ${control === 'select-other' ? 'public selection change is refused (measured)' : 'no further identical SUBSCRIBE on this connection'}`, async () => {
        const f = await playing(draft);
        try {
          await f.run(70); const rep = await f.replacementSeen(); await f.refuse(rep.id, 1n);
          if (control === 'pause') f.player.pause();
          else if (control === 'destroy') await f.player.destroy();
          else if (control === 'goaway') {
            await f.server.sendGoaway({ newSessionUri: '', requestId: 1000n, timeout: 0n }); await flush(128);
            expect(f.client.session.state).toBe('draining');
          }
          else await f.player.selectVideoTrack('video2').then(() => f.log('player:selectVideoTrack(video2) resolved'), (e: unknown) => f.log('player:selectVideoTrack(video2) rejected', e instanceof Error ? e.message : String(e)));
          await f.run(400);
          const others = f.requests.filter(r => r.id > rep.id);
          console.log(`[issue52 d${draft} ${control}] later requests: ${others.map(r => `${r.name}#${r.id}`).join(',') || 'none'}\n` + f.timeline());
          if (control === 'select-other') {
            // MEASURED: during the incident the public selection change is refused synchronously
            // ("video selection not ready" — no current video request id while the replacement is
            // refused/retired), so this control cannot be exercised through the public path; the
            // ladder continues on the original identity (covered by the Retry Interval cases).
            const settled = f.events.find(e => e.kind.startsWith('player:selectVideoTrack(video2)'));
            expect(settled).toBeDefined();
            if (settled!.kind.endsWith('rejected')) {
              expect(settled!.detail).toContain('video selection not ready');
              expect(others.filter(r => r.name === 'video2')).toEqual([]);
            } else {
              // Selection change took effect: the abandoned identity must not be re-sent by the ladder.
              expect(others.some(r => r.name === 'video2')).toBe(true);
              expect(f.identitySubscribesAfter(rep.id)).toEqual([]);
            }
          } else {
            expect(f.identitySubscribesAfter(rep.id)).toEqual([]);
            if (control === 'goaway') { expect(f.candidateConnects(), 'migration used a fresh connection/transport pair').toBe(2); expect(f.requests.filter(r => r.id > rep.id)).toEqual([]); }
          }
          expect(f.errors.filter(e => e.severity === 'fatal' && e.code !== 4101)).toEqual([]);
        } finally { if (control !== 'destroy') await f.close(); else { await f.client.close(); await f.server.close(); } }
      });
    }
  });

  it('SAME-CLOCK ARRIVAL: the replacement\'s first object stamped exactly at the attempt start counts as recovery (request-owned, >=); no extra attempt while the publisher then pauses for the probe', async () => {
    const f = await playing(draft);
    try {
      await f.run(70); expect(f.recovery.map(r => r.attempt)).toEqual([1]);
      // Attempt 2 and its replacement SUBSCRIBE happen inside one fake-clock instant; serve it WITHOUT advancing time.
      const replacement = await f.replacementSeenSameInstant();
      const attemptStart = f.recovery[1]!.t; expect(f.now()).toBe(attemptStart);
      const live = await f.deliverOn(replacement.id, 1n);
      expect(f.arrivals.at(-1)).toBe(attemptStart);
      // The probe polls every ~10ms: within one poll the ladder must have ENDED on that same-instant object.
      // (Retained recovery state is inspected the way sibling loopback suites do; a probe timeout cannot be
      // told apart from a fresh starvation incident through public events alone, since both scale with livenessTimeoutMs.)
      const restarts = (f.player as unknown as { livenessRestarts: Map<string, { active: boolean; attempts: number }> }).livenessRestarts;
      await f.run(15);
      const state = [...restarts.values()].map(r => `attempts=${r.attempts} active=${r.active}`).join('|');
      console.log(`[issue52 d${draft} same-clock] 15ms after a same-instant delivery: ${state}; attempts so far ${f.recovery.map(r => r.attempt).join(',')}`);
      expect([...restarts.values()].every(r => !r.active), 'ladder still probing although the replacement delivered at attemptStart').toBe(true);
      // Publisher resumes inside the liveness window (no new incident) — no further attempt may follow.
      await f.keepDelivering(live, 200);
      expect(f.recovery.map(r => r.attempt), 'a delivered object at attemptStart must count as recovery').toEqual([1, 2]);
      expect(f.recovery.map(r => r.attempt)).toEqual([1, 2]); expect(f.errors.filter(e => e.code === 4101)).toEqual([]); expect(f.player.state).toBe('playing');
    } finally { await f.close(); }
  });

  it('NEGATIVE: an older object on the ORIGINAL request, arriving before attempt 2 starts, does not satisfy the replacement\'s probe', async () => {
    const f = await playing(draft);
    try {
      await f.run(70); expect(f.recovery.map(r => r.attempt)).toEqual([1]);
      // Attempt 1's probe ends at ~+114ms; deliver one late object on the ORIGINAL subscription (alias 50) just before attempt 2 (+119ms).
      await f.run(45);
      const s0 = await f.server.openSubgroup(50n, 1n, 0n); await f.server.sendObject(s0, 0n, Uint8Array.of(7)); await flush(128); f.player.tick();
      const lateOriginal = f.now();
      await f.run(10);
      // If the late object had been read as recovery of attempt 1, attempt 2 would not exist (or would be a later incident).
      const replacement = await f.replacementSeen();
      expect(f.recovery.length).toBeGreaterThanOrEqual(2);
      const attemptStart = f.recovery.at(-1)!.t;
      console.log(`[issue52 d${draft} negative-original] late original object at +${lateOriginal - f.lastObjectAt}ms; attempt ${f.recovery.at(-1)!.attempt} at +${attemptStart - f.lastObjectAt}ms\n` + f.timeline());
      // The replacement delivers nothing: its probe must expire and the ladder must continue (the old arrival is not this request's).
      await f.run(LIVENESS.livenessTimeoutMs + 20);
      expect(f.recovery.at(-1)!.attempt).toBeGreaterThan(f.recovery.find(r => r.t === attemptStart)!.attempt);
      void replacement;
    } finally { await f.close(); }
  });

  it('DEAD REQUEST STREAM: after the peer resets the request stream the SDK subscription is absent while the liveness route is armed; the ladder must still replace it', async () => {
    const f = await playing(draft);
    try {
      f.peerResetRequestStream(0); await flush(128); await f.run(10);
      const sdk = f.client.session.getSubscription(0n);
      console.log(`[issue52 d${draft} dead-request] SDK subscription for request 0 after peer reset: ${sdk ? sdk.state : 'absent'}; player state ${f.player.state}`);
      expect(sdk, 'SDK dropped the subscription on the peer reset').toBeUndefined();
      expect(f.player.state).toBe('playing');
      await f.run(60); // starvation → attempt 1 (refresh must fail: no request stream) → replacement
      let replacement: Req | undefined;
      for (let i = 0; i < 60 && !replacement; i++) { await f.run(5); replacement = f.requests.find((r, idx) => idx > 0 && r.name === 'video'); }
      console.log(`[issue52 d${draft} dead-request]\n` + f.timeline());
      // The SDK surfaces the peer reset itself as a connection error (code 4096, severity fatal) while the
      // player keeps playing; recorded, not judged here. The claim is about the recovery ladder only.
      const starved = () => f.errors.filter(e => e.code === 4101).map(e => e.message);
      expect(f.recovery.length).toBeGreaterThanOrEqual(1);
      expect(starved(), 'no MEDIA_STARVED fatal instead of a replacement').toEqual([]);
      expect(replacement, 'a replacement SUBSCRIBE for the dead local request').toBeDefined();
      const live = await f.deliverOn(replacement!.id, 1n); await f.keepDelivering(live, 200);
      expect(f.player.state).toBe('playing'); expect(starved()).toEqual([]);
    } finally { await f.close(); }
  });

  describe('bounded retirement with the starvation monitor disabled (livenessTimeoutMs 0)', () => {
    // The monitor is off, so the ladder is driven directly (as the terminal-delivery neighbour does); the
    // refresh is made to fail so attempt 1 reaches the full resubscribe, and the local unsubscribe is HELD.
    async function heldRetirement(control: 'expire' | 'pause' | 'destroy') {
      const f = await playing(draft, { config: { livenessTimeoutMs: 0, connectionTimeoutMs: 30, livenessMaxRestarts: 1 } });
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const realUnsub = f.client.unsubscribe.bind(f.client);
      const unsub = vi.spyOn(f.client, 'unsubscribe').mockImplementation(async id => { await gate; return realUnsub(id); });
      vi.spyOn(f.client, 'requestUpdate').mockRejectedValue(new Error('refresh refused'));
      const internals = f.player as unknown as { handleTrackStarvation(track: { requestId: bigint; trackAlias: bigint; mediaType: 'video'; trackName: string }, starvedForMs: number, healthyForMs: number): Promise<void> };
      const ladder = internals.handleTrackStarvation({ requestId: 0n, trackAlias: 50n, mediaType: 'video', trackName: 'video' }, 100, 0);
      try {
        await f.run(10); expect(unsub).toHaveBeenCalledOnce();
        expect(f.identitySubscribesAfter(0n)).toEqual([]);
        if (control === 'pause') f.player.pause(); else if (control === 'destroy') await f.player.destroy();
        await f.run(60); // past connectionTimeoutMs (30) while the unsubscribe is still held
        const starved = f.errors.filter(e => e.code === 4101).map(e => e.message);
        console.log(`[issue52 d${draft} disabled-monitor ${control}] starved=${JSON.stringify(starved)} requests=${f.requests.map(r => `${r.name}#${r.id}`).join(',')}`);
        expect(f.identitySubscribesAfter(0n), 'no replacement while local retirement is unresolved').toEqual([]);
        if (control === 'expire') { expect(starved).toHaveLength(1); expect(starved[0]).toContain('local subscription retirement did not complete'); }
        else expect(starved).toEqual([]);
        release(); await ladder; await f.run(60);
        expect(f.identitySubscribesAfter(0n), 'late retirement never sends a request').toEqual([]);
      } finally { release(); await ladder.catch(() => {}); if (control !== 'destroy') await f.close(); else { await f.client.close(); await f.server.close(); } }
    }
    it('expiry of the bounded wait (connectionTimeoutMs) ends the recovery without a replacement, and a late completion sends nothing', () => heldRetirement('expire'));
    it('pause during the held retirement cancels ownership: no replacement, no starvation fatal', () => heldRetirement('pause'));
    it('destroy during the held retirement cancels ownership: no replacement, no starvation fatal', () => heldRetirement('destroy'));
  });

  it('healthy delivery never starts the ladder (routing/liveness accounting, not rendered playback)', async () => {
    const f = await playing(draft);
    try {
      const s = await f.server.openSubgroup(50n, 1n, 0n);
      for (let i = 1n; i <= 8n; i++) { await f.server.sendObject(s, i, Uint8Array.of(3)); await f.run(20); }
      expect(f.recovery).toEqual([]); expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });
});

describe('issue #52 legacy drafts: provenance of the Retry Interval', () => {
  it('draft 14: SUBSCRIBE_ERROR has no Retry Interval (§9.9); the codec placeholder 0 is not a peer refusal, so the ladder may retry by its own policy', async () => {
    const f = await playing(14);
    try {
      await f.run(70); const rep = await f.replacementSeen(); const refusedAt = f.now();
      await f.refuse(rep.id, 0n); // wire: SUBSCRIBE_ERROR [requestId, code, reason]; normalized retryInterval 0 is synthesized locally
      expect(f.events.some(e => e.kind === 'player:track_subscribe_failed' && e.detail?.includes(`id=${rep.id}`))).toBe(true);
      let retry: Req | undefined;
      for (let i = 0; i < 60 && !retry; i++) { await f.run(5); retry = f.identitySubscribesAfter(rep.id)[0]; }
      console.log(`[issue52 d14] retry after SUBSCRIBE_ERROR: ${retry ? `+${retry.t - refusedAt}ms` : 'none'}\n` + f.timeline());
      expect(retry, 'legacy retry by existing policy').toBeDefined();
      expect(f.errors.filter(e => e.severity === 'fatal')).toEqual([]);
      await f.deliverOn(retry!.id, 2n); expect(f.arrivals).toHaveLength(2); expect(f.player.state).toBe('playing');
    } finally { await f.close(); }
  });

  it('draft 16: an actual Retry Interval 0 on the control stream is a peer refusal — no automatic identical retry', async () => {
    const f = await playing(16);
    try {
      await f.run(70); const rep = await f.replacementSeen();
      await f.refuse(rep.id, 0n);
      expect(f.events.some(e => e.kind === 'player:track_subscribe_failed' && e.detail?.includes(`id=${rep.id}`))).toBe(true);
      const restarts = f.recovery.length;
      await f.run(600);
      console.log(`[issue52 d16 retry=0]\n` + f.timeline());
      expect(f.identitySubscribesAfter(rep.id)).toEqual([]);
      expect(f.recovery.length).toBe(restarts);
    } finally { await f.close(); }
  });
});

// Opt-in announcement recovery; MSE output is modeled, not browser playback.
async function announcedPlayer(draft: 14 | 16 | 18 | 22, enabled = true, refused = false, mse = false, monitor = true) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const codec = createControlCodec(draft), isolated = createLoopback().a;
  let namespaceOptions: bigint | undefined;
  const requests: bigint[] = [], arrivals: number[] = [], watches: bigint[] = [];
  server.onSubscribe = id => { requests.push(id); };
  server.onSubscribeNamespace = id => { watches.push(id); };
  // Legacy namespace serving is not implemented by the SDK. Inject only that
  // peer protocol; media and the player still traverse the real adapters.
  if (draft === 16) {
    const open = a.createBidirectionalStream.bind(a);
    vi.spyOn(a, 'createBidirectionalStream').mockImplementation(() =>
      a.bidiOut.length ? isolated.createBidirectionalStream() : open());
    const subscribe = client.subscribeNamespace.bind(client);
    vi.spyOn(client, 'subscribeNamespace').mockImplementation(async (...args) => {
      const id = await subscribe(...args); watches.push(id);
      const chunks = isolated.bidiOut.at(-1)!.out.written;
      const wire = Uint8Array.from(chunks.flatMap(chunk => [...chunk]));
      const message = codec.decode(wire, 0).message;
      expect(message.type).toBe('SUBSCRIBE_NAMESPACE');
      if (message.type === 'SUBSCRIBE_NAMESPACE') namespaceOptions = message.subscribeOptions;
      return id;
    });
  } else if (draft === 14) {
    const handle = server.session.handleControlMessage.bind(server.session);
    vi.spyOn(server.session, 'handleControlMessage').mockImplementation(msg => {
      if (msg.type === 'SUBSCRIBE_NAMESPACE') {
        watches.push(msg.requestId);
        // Account for the legacy peer's sequential request-ID allocation.
        (server.session as unknown as { validateAndReplenish(id: bigint): unknown }).validateAndReplenish(msg.requestId);
        return [];
      }
      return handle(msg);
    });
  }
  const source: MediaSourceLike = { initialize: () => true, appendChunk: vi.fn(), reset() {},
    endOfStream() {}, destroy() {}, mediaElement: null, onFirstFrame: null, onError: null, onStall: null };
  const player = new MoqtPlayer({
    url: 'https://relay.invalid/moq', namespace: 'live', draftVersion: draft,
    ...(enabled ? { publisherWaitMs: 20_000 } : {}),
    createConnection: () => client,
    createTransport: async () => { void server.connect(b, { maxRequestId: varint(1_000_000) }).catch(() => {}); return a; },
    catalog: { version: 1, tracks: [{ name: 'video', role: 'video', packaging: mse ? 'cmaf' : 'loc', isLive: true,
      ...(mse ? { initData: Buffer.from(videoInit()).toString('base64') } : {}),
      codec: 'avc1.640028', width: 10, height: 10, renderGroup: 1 }] },
    ...(mse ? { createMediaSource: () => source } : {}),
    createCmafAssembler: callbacks => ({
      push: (mediaType, track, group, payload) => callbacks.onSegment(mediaType, payload, track, group),
      getEpoch: () => null, reset() {}, destroy() {},
    }),
    disableAudio: true, autoQuality: false, ...(monitor ? {} : { livenessTimeoutMs: 0 }),
  });
  player.on('media_object', e => { if (e.mediaType === 'video') arrivals.push(performance.now()); });
  await player.load(); await flush(128);
  let published: bigint | undefined;
  async function announce(done = false) {
    if (!watches.length || refused) return;
    if (draft === 14) {
      if (done) await server.publishNamespaceDone(published!);
      else published = await server.publishNamespace([new TextEncoder().encode('live')]);
    } else if (draft === 16) {
      if (namespaceOptions !== 1n && namespaceOptions !== 2n) return;
      isolated.bidiOut[0]!.in.injectRead(codec.encode({ type: done ? 'NAMESPACE_DONE' : 'NAMESPACE', trackNamespaceSuffix: [] }));
    } else if (done) await server.sendNamespaceDone(watches[0]!, []);
    else await server.sendNamespace(watches[0]!, []);
    await flush(128);
  }
  if (watches.length) {
    if (draft === 14 || draft === 16) {
      const pipe = draft === 14 ? a.bidiOut[0]!.in : isolated.bidiOut[0]!.in;
      pipe.injectRead(refused ? codec.encode({ type: 'REQUEST_ERROR', requestId: varint(watches[0]!),
        errorCode: varint(1), errorReason: 'unavailable', retryInterval: varint(0), requestKind: 'SUBSCRIBE_NAMESPACE' })
        : draft === 14 ? Uint8Array.of(0x12, 0, 1, Number(watches[0]!))
        : codec.encode({ type: 'REQUEST_OK', requestId: varint(watches[0]!), parameters: new Map() }));
    } else if (refused) await server.rejectSubscribeNamespace(watches[0]!, 1n, 'unavailable');
    else await server.acceptSubscribeNamespace(watches[0]!);
    await flush(128); await announce();
  }
  await server.acceptSubscribe(requests[0]!, 50n); await flush(128); player.play();
  const stream = await server.openSubgroup(50n, 0n, 0n);
  await server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128); player.tick();
  if (mse) source.onFirstFrame?.();
  expect(arrivals).toHaveLength(1);
  server.setLargestLocationProvider(() => ({ group: 0n, object: 0n }));
  return { a, player, client, server, requests, arrivals, watches, stream, namespaceOptions,
    announce,
    async advance(ms: number) { await vi.advanceTimersByTimeAsync(ms); await flush(128); player.tick(); },
    async close() { await player.destroy(); await client.close(); await server.close(); },
  };
}

describe.each([14, 16, 18, 22] as const)('publisher return draft %i', draft => {
  it.each([false, true])('resumes within one second of a re-announcement during the old recovery probe (MSE=%s)', async mse => {
    const f = await announcedPlayer(draft, true, false, mse);
    try {
      await f.announce(true); await f.advance(12_000);
      const returned = performance.now(); await f.announce();
      for (let elapsed = 0; f.requests.length < 2 && elapsed < 1000; elapsed += 50) await f.advance(50);
      expect(f.requests).toHaveLength(2);
      await f.server.acceptSubscribe(f.requests[1]!, 60n); await flush(128);
      const stream = await f.server.openSubgroup(60n, 1n, 0n);
      await f.server.sendObject(stream, 0n, Uint8Array.of(2)); await flush(128);
      expect(f.arrivals).toHaveLength(2);
      expect(f.arrivals[1]! - returned).toBeLessThan(1000);
      await f.advance(5000); expect(f.requests).toHaveLength(2); expect(f.watches).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(['off', 'refused'] as const)('preserves the original ladder when discovery is %s', async mode => {
    const f = await announcedPlayer(draft, mode !== 'off', mode === 'refused');
    try {
      await f.advance(12_000); expect(f.requests).toHaveLength(1);
      await f.advance(10_000); expect(f.requests).toHaveLength(2);
      expect(f.watches).toHaveLength(mode === 'off' ? 0 : 1);
    } finally { await f.close(); }
  });

  it('leaves a route that received after withdrawal alone', async () => {
    const f = await announcedPlayer(draft);
    try {
      expect(f.requests).toHaveLength(1); await f.announce(true);
      await f.server.sendObject(f.stream, 1n, Uint8Array.of(2)); await flush(128);
      await f.announce(); await f.advance(500);
      expect(f.arrivals).toHaveLength(2); expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('does not send a second SUBSCRIBE on a timer after announcement refusal', async () => {
    const f = await announcedPlayer(draft);
    try {
      await f.announce(true); await f.announce(); await f.advance(50);
      expect(f.requests).toHaveLength(2);
      await f.server.rejectSubscribe(f.requests[1]!, 0x10n, 'gone'); await flush(128);
      await f.advance(25_000); expect(f.requests).toHaveLength(2);
    } finally { await f.close(); }
  });
});


describe.each([18, 22] as const)('publisher discovery ownership draft %i', draft => {
  it('surfaces PREFIX_OVERLAP for an application namespace subscription', async () => {
    const f = await announcedPlayer(draft);
    const messages: unknown[] = [];
    const observe = f.client.onMessage;
    f.client.onMessage = msg => { messages.push(msg); observe?.(msg); };
    try {
      const id = await f.player.subscribeNamespace('live'); await flush(128);
      expect(messages).toContainEqual(expect.objectContaining({ type: 'REQUEST_ERROR', requestId: id, errorCode: 0x30n }));
      expect(f.watches).toHaveLength(1); expect(f.client.session.state).toBe('established');
    } finally { await f.close(); }
  });

  it('disables the watch for the session after its stream ends', async () => {
    const f = await announcedPlayer(draft);
    try {
      expect(f.watches).toHaveLength(1); await f.announce(true);
      // Peer FIN retires the watch; no replacement watch is opened.
      const contexts = (f.server as unknown as { inboundRequestContexts: Map<bigint, { terminate(): Promise<void> }> }).inboundRequestContexts;
      await contexts.get(f.watches[0]!)!.terminate(); await flush(128);
      expect(f.client.session.getNamespaceSubscription(f.watches[0]!)).toBeUndefined();
      await f.advance(12_000); expect(f.requests).toHaveLength(1); expect(f.watches).toHaveLength(1);
    } finally { await f.close(); }
  });
});


it('replaces once on the announcement even with timer-based liveness disabled', async () => {
  const f = await announcedPlayer(18, true, false, false, false);
  try {
    await f.announce(true); await f.advance(30_000); expect(f.requests).toHaveLength(1);
    await f.announce(); await flush(128); expect(f.requests).toHaveLength(2);
    await f.server.acceptSubscribe(f.requests[1]!, 60n); await flush(128);
    const stream = await f.server.openSubgroup(60n, 1n, 0n);
    await f.server.sendObject(stream, 0n, Uint8Array.of(2)); await flush(128);
    expect(f.arrivals).toHaveLength(2);
    await f.advance(30_000); expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});


it.each([0x10n, 1n])('a new announcement only exempts a DOES_NOT_EXIST zero retry refusal (code=%s)', async code => {
  const f = await announcedPlayer(18);
  try {
    await f.announce(true); await f.announce(); await f.advance(50);
    expect(f.requests).toHaveLength(2);
    await f.server.rejectSubscribe(f.requests[1]!, code, 'refused'); await flush(128);
    await f.announce(true); await f.announce(); await f.advance(50);
    expect(f.requests).toHaveLength(code === 0x10n ? 3 : 2);
  } finally { await f.close(); }
});

it('honors a positive media Retry Interval even on a new announcement', async () => {
  const f = await announcedPlayer(18);
  try {
    await f.announce(true); await f.announce(); await f.advance(50);
    expect(f.requests).toHaveLength(2);
    f.a.bidiOut.at(-1)!.in.injectRead(createControlCodec(18).encode({ type: 'REQUEST_ERROR',
      requestId: varint(f.requests[1]!), errorCode: varint(0x10), retryInterval: varint(10_001), errorReason: 'not yet' })); await flush(128);
    await f.announce(true); await f.announce(); await f.advance(1000);
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});

// Initial catalog wait uses the same accepted session watch.
async function waiting(draft: 18 | 22, mode: 'accepted' | 'refused' | 'off' | 'pending' = 'accepted', holdWatch = false) {
  const pair = await connectedPair(draft);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  if (holdWatch) {
    const subscribe = pair.client.subscribeNamespace.bind(pair.client);
    vi.spyOn(pair.client, 'subscribeNamespace').mockImplementation(async (...args) => {
      const id = await subscribe(...args); await held; return id;
    });
  }
  const requests: Array<{ id: bigint; name: string }> = [], watches: bigint[] = [], errors: string[] = [];
  pair.server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
  pair.server.onSubscribeNamespace = id => {
    watches.push(id);
    if (mode === 'refused') void pair.server.rejectSubscribeNamespace(id, 1n, 'unavailable');
    else if (mode !== 'pending') void pair.server.acceptSubscribeNamespace(id);
  };
  const player = new MoqtPlayer({ connection: pair.client as unknown as MoqtConnection, url: 'https://relay.invalid/moq', namespace: 'live',
    catalogBootstrap: 'subscribe', publisherWaitMs: mode === 'off' ? 0 : 20_000, disableAudio: true, autoQuality: false });
  player.on('error', e => { if (e.error.severity === 'fatal') errors.push(e.error.message); });
  await player.load(); await flush(128);
  const catalogs = () => requests.filter(r => r.name === 'catalog');
  return { ...pair, player, requests, watches, errors, catalogs,
    async refuse(code = 0x10n, interval = 0n) {
      if (interval === 0n) await pair.server.rejectSubscribe(catalogs().at(-1)!.id, code, 'unroutable');
      else pair.a.bidiOut.at(-1)!.in.injectRead(createControlCodec(draft).encode({ type: 'REQUEST_ERROR',
        requestId: varint(catalogs().at(-1)!.id), errorCode: varint(code), retryInterval: varint(interval), errorReason: 'unroutable' }));
      await flush(128);
    },
    async announce() { await pair.server.sendNamespace(watches[0]!, []); await flush(128); },
    async advance(ms: number) { await vi.advanceTimersByTimeAsync(ms); await flush(128); },
    async close() { release(); await player.destroy(); await pair.client.close(); await pair.server.close(); },
  };
}

describe.each([18, 22] as const)('announced catalog draft %i', draft => {
  it('waits beyond the old watchdog, then re-subscribes once and delivers media', async () => {
    const f = await waiting(draft);
    const arrivals: unknown[] = [];
    f.player.on('media_object', event => { arrivals.push(event); });
    try {
      await f.refuse(); await f.advance(12_000);
      expect(f.errors).toEqual([]); expect(f.catalogs()).toHaveLength(1);
      await f.announce(); expect(f.catalogs()).toHaveLength(2);
      await f.server.sendNamespaceDone(f.watches[0]!, []); await f.announce();
      expect(f.catalogs()).toHaveLength(2);
      await f.server.acceptSubscribe(f.catalogs()[1]!.id, 50n); await flush(128);
      const catalog = await f.server.openSubgroup(50n, 0n, 0n);
      await f.server.sendObject(catalog, 0n, new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
        { name: 'video', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', width: 10, height: 10, renderGroup: 1 },
      ] }))); await flush(256);
      const media = f.requests.find(r => r.name === 'video'); expect(media).toBeDefined();
      await f.server.acceptSubscribe(media!.id, 60n); await flush(128); f.player.play();
      const stream = await f.server.openSubgroup(60n, 0n, 0n);
      await f.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
      expect(arrivals).toHaveLength(1); expect(f.player.state).toBe('playing');
      await f.advance(8001); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('expires at the bound without polling', async () => {
    const f = await waiting(draft);
    try {
      await f.refuse(); await f.advance(19_999); expect(f.errors).toEqual([]);
      await f.advance(1); expect(f.errors).toHaveLength(1); expect(f.player.state).toBe('error');
      expect(f.catalogs()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(['off', 'refused'] as const)('keeps the immediate fatal refusal when discovery is %s', async mode => {
    const f = await waiting(draft, mode);
    try { await f.refuse(); expect(f.player.state).toBe('error'); expect(f.catalogs()).toHaveLength(1); }
    finally { await f.close(); }
  });

  it('keeps other catalog refusal codes fatal immediately', async () => {
    const f = await waiting(draft);
    try { await f.refuse(1n); expect(f.player.state).toBe('error'); expect(f.catalogs()).toHaveLength(1); }
    finally { await f.close(); }
  });

  it('does not extend the original wait bound after a second refusal', async () => {
    const f = await waiting(draft);
    try {
      await f.refuse(); await f.advance(19_000); await f.announce(); expect(f.catalogs()).toHaveLength(2);
      await f.refuse(); await f.advance(1000); expect(f.player.state).toBe('error');
      expect(f.catalogs()).toHaveLength(2);
    } finally { await f.close(); }
  });

  it.each(['announcement', 'timer'] as const)('keeps the positive Retry Interval race single-shot when %s wins', async winner => {
    const f = await waiting(draft);
    try {
      await f.refuse(0x10n, 5001n);
      await f.advance(winner === 'timer' ? 5000 : 1000);
      await f.announce(); expect(f.catalogs()).toHaveLength(winner === 'timer' ? 2 : 1);
      if (winner === 'announcement') { await f.advance(3999); expect(f.catalogs()).toHaveLength(1); await f.advance(1); }
      await f.advance(5001); expect(f.catalogs()).toHaveLength(2); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not re-subscribe on an announcement from a draining session', async () => {
    const f = await waiting(draft);
    try {
      await f.refuse(); expect(f.errors).toEqual([]);
      await f.server.sendGoaway({ newSessionUri: '', requestId: 100n, timeout: 0n }); await flush(128);
      await f.announce(); await f.advance(1000); expect(f.catalogs()).toHaveLength(1);
    } finally { await f.close(); }
  });
});


it('bounds the catalog wait even while the namespace send promise is held', async () => {
  const f = await waiting(18, 'accepted', true);
  try {
    await f.refuse(); await f.advance(19_999); expect(f.errors).toEqual([]);
    await f.advance(1); expect(f.player.state).toBe('error'); expect(f.catalogs()).toHaveLength(1);
  } finally { await f.close(); }
});


describe.each([18, 22] as const)('repair catalog wait draft %i', draft => {
  it('keeps the positive retry after the announcement bound and receives the catalog', async () => {
    const f = await waiting(draft);
    const received: unknown[] = [];
    f.player.on('catalog_received', event => received.push(event));
    try {
      await f.refuse(0x10n, 30_001n); await f.advance(20_000);
      expect(f.errors).toEqual([]); expect(f.catalogs()).toHaveLength(1);
      await f.advance(9999); expect(f.catalogs()).toHaveLength(1);
      await f.advance(1); expect(f.catalogs()).toHaveLength(2);
      await f.server.acceptSubscribe(f.catalogs()[1]!.id, 50n); await flush(128);
      const stream = await f.server.openSubgroup(50n, 0n, 0n);
      await f.server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify({ version: 1, tracks: [
        { name: 'video', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', width: 10, height: 10, renderGroup: 1 },
      ] }))); await flush(128);
      expect(received).toHaveLength(1); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('allows the watch acceptance to follow the catalog refusal', async () => {
    const f = await waiting(draft, 'pending');
    try {
      await f.refuse(); expect(f.errors).toEqual([]);
      await f.server.acceptSubscribeNamespace(f.watches[0]!); await f.announce();
      expect(f.catalogs()).toHaveLength(2); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('retires the refusal bound when the replacement catalog subscription is accepted', async () => {
    const f = await waiting(draft);
    try {
      await f.refuse(); await f.advance(19_000); await f.announce();
      await f.server.acceptSubscribe(f.catalogs()[1]!.id, 50n); await flush(128);
      await f.advance(1500); expect(f.errors).toEqual([]); expect(f.player.state).not.toBe('error');
    } finally { await f.close(); }
  });
  it('keeps catalog_received pending on the watchdog during the publisher wait', async () => {
    const f = await waiting(draft);
    const watchdog = (f.player as unknown as { watchdog: { fulfill(event: string): void } }).watchdog;
    const fulfill = vi.spyOn(watchdog, 'fulfill');
    try { await f.refuse(); expect(fulfill).not.toHaveBeenCalledWith('catalog_received'); }
    finally { await f.close(); }
  });
});

describe.each([[0x10n, 'MALFORMED_AUTH_TOKEN'], [0x4n, 'TRACK_DOES_NOT_EXIST']] as const)('draft-14 catalog refusal %s (%s)', (code, label) => {
  it(code === 0x4n ? 'waits for an announcement on TRACK_DOES_NOT_EXIST' : 'fails immediately on MALFORMED_AUTH_TOKEN', async () => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(14), server = new MoqtConnection(14, { role: 'server' });
    const requests: Array<{ id: bigint; name: string }> = [], watches: bigint[] = [], errors: string[] = [];
    server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
    const handle = server.session.handleControlMessage.bind(server.session);
    vi.spyOn(server.session, 'handleControlMessage').mockImplementation(msg => {
      if (msg.type === 'SUBSCRIBE_NAMESPACE') {
        watches.push(msg.requestId);
        (server.session as unknown as { validateAndReplenish(id: bigint): unknown }).validateAndReplenish(msg.requestId);
        return [];
      }
      return handle(msg);
    });
    const player = new MoqtPlayer({ url: 'https://relay.invalid/moq', namespace: 'live', draftVersion: 14,
      publisherWaitMs: 20_000, catalogBootstrap: 'subscribe', disableAudio: true, autoQuality: false,
      createConnection: () => client,
      createTransport: async () => { void server.connect(b, { maxRequestId: varint(1_000_000) }).catch(() => {}); return a; } });
    player.on('error', e => { if (e.error.severity === 'fatal') errors.push(e.error.message); });
    try {
      await player.load(); await flush(128);
      if (watches.length) { a.bidiOut[0]!.in.injectRead(Uint8Array.of(0x12, 0, 1, Number(watches[0]!))); await flush(128); }
      const cat = requests.find(r => r.name === 'catalog')!;
      await server.rejectSubscribe(cat.id, code, label); await flush(128);
      const immediate = player.state;
      await vi.advanceTimersByTimeAsync(5000); await flush(128);
      expect(immediate).toBe(code === 0x4n ? 'loading' : 'error');
    } finally { await player.destroy(); await client.close(); await server.close(); }
  });
});


it('allows an announcement once a short positive minimum has elapsed, before base backoff', async () => {
  const f = await waiting(18);
  try {
    await f.refuse(0x10n, 1n); await f.advance(500); expect(f.catalogs()).toHaveLength(1);
    await f.announce(); expect(f.catalogs()).toHaveLength(2);
    await f.advance(1000); expect(f.catalogs()).toHaveLength(2);
  } finally { await f.close(); }
});


it('repair d16 requests NAMESPACE with Subscribe Options 0x01 on the wire', async () => {
  const f = await announcedPlayer(16);
  try { expect(f.namespaceOptions).toBe(1n); }
  finally { await f.close(); }
});

describe.each([18, 22] as const)('repair announced media failure draft %i', draft => {
  it.each([0x10n, 1n])('ends a refused replacement in MEDIA_STARVED within its bound (code=%s)', async code => {
    const f = await announcedPlayer(draft), fatal: number[] = [];
    f.player.on('error', event => { if (event.error.severity === 'fatal') fatal.push(event.error.code); });
    try {
      await f.announce(true); await f.announce(); expect(f.requests).toHaveLength(2);
      await f.server.rejectSubscribe(f.requests[1]!, code, 'not ready'); await flush(128);
      if (code === 0x10n) {
        expect(fatal).toEqual([]); await f.advance(19_999); expect(fatal).toEqual([]);
        await f.advance(1);
      }
      expect(fatal).toEqual([0x1005]); expect(f.player.state).toBe('error');
      expect(f.requests).toHaveLength(2);
    } finally { await f.close(); }
  });
  it('reports MEDIA_STARVED when the announced replacement fails to send', async () => {
    const f = await announcedPlayer(draft), fatal: number[] = [];
    f.player.on('error', event => { if (event.error.severity === 'fatal') fatal.push(event.error.code); });
    try {
      vi.spyOn(f.client, 'subscribe').mockRejectedValueOnce(new Error('send failed'));
      await f.announce(true); await f.announce(); await flush(256);
      expect(fatal).toEqual([0x1005]); expect(f.player.state).toBe('error');
    } finally { await f.close(); }
  });
});

it('repair healthy arrivals avoid the withdrawal subscription scan and JSON encoding', async () => {
  const f = await announcedPlayer(18);
  const owner = f.player as unknown as { activeSubscriptions: Map<bigint, unknown>; stampMediaArrival(alias: bigint): void };
  const scan = vi.spyOn(owner.activeSubscriptions, 'values'), json = vi.spyOn(JSON, 'stringify');
  try {
    owner.stampMediaArrival(50n);
    expect(scan).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
  } finally { scan.mockRestore(); json.mockRestore(); await f.close(); }
});

it('repair d14 refuses forwarded unsolicited PUBLISH with UNINTERESTED', async () => {
  const f = await announcedPlayer(14), responses: ControlMessage[] = [];
  f.server.onMessage = message => responses.push(message);
  try {
    const id = await f.server.publish([new TextEncoder().encode('live')], new TextEncoder().encode('unsolicited'), 90n);
    await flush(256);
    expect(responses).toContainEqual(expect.objectContaining({ type: 'REQUEST_ERROR', requestId: id, errorCode: 4n }));
    await f.player.destroy(); expect(f.client.onPublish).toBeUndefined();
  } finally { await f.close(); }
});
