import { DiagnosticCapture } from '@openmoq/devtools';
import { encodeMessage, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import { MoqtConnection } from '@openmoq/webtransport';
import { varint, validateTrackNamespace, validateFullTrackName } from '@openmoq/transport';
import type { Fact, SourceDescriptor } from '@openmoq/devtools-protocol';
import type { ObjectReceipt, ObjectReceiptObservation, WebTransportLike } from '@openmoq/webtransport';

export interface ProbeConfig {
  readonly url: string;
  readonly namespace: readonly string[];
  readonly draft: 16 | 18 | 22;
  readonly trackHints?: readonly string[];
  readonly policy?: 'strict' | 'compatibility';
}
export interface ProbeRun {
  readonly source: SourceDescriptor;
  readonly capture: DiagnosticCapture;
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}
export interface ProbeOptions {
  readonly ownerId: string;
  readonly clock: { readonly id: string; readonly now: () => number };
  readonly transportFactory: (options: { readonly url: string; readonly protocols: readonly string[]; readonly signal: AbortSignal }) => Promise<WebTransportLike & { readonly ready?: Promise<unknown> }>;
  readonly attemptTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}
export interface ProbeRunner {
  start(config: ProbeConfig): ProbeRun;
  dispose(): Promise<void>;
}
class ProbeTimeout extends Error { constructor() { super('Probe operation timed out'); } }

function checkedText(value: string): void {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 1024) throw new Error('Probe identity text limit exceeded');
  for (const c of value) { const p = c.codePointAt(0)!; if (p >= 0xd800 && p <= 0xdfff) throw new Error('Invalid Unicode in Probe identity'); }
}
function checkedConfig(input: ProbeConfig): ProbeConfig {
  if (![16, 18, 22].includes(input.draft)) throw new Error('Unsupported Probe draft');
  if (input.policy !== undefined && input.policy !== 'strict' && input.policy !== 'compatibility') throw new Error('Invalid Probe policy');
  const url = new URL(input.url.replace(/^moqt:/, 'https:'));
  if (input.url.length > 8192 || url.protocol !== 'https:' || url.username || url.password || input.url.includes('#')) throw new Error('Invalid Probe WebTransport URL');
  if (!Array.isArray(input.namespace) || input.namespace.length > 32 || (input.draft === 16 && input.namespace.length === 0)) throw new Error('Invalid Probe namespace');
  input.namespace.forEach(checkedText);
  const namespace = input.namespace.map(field => new TextEncoder().encode(field));
  validateTrackNamespace(namespace, { allowEmpty: input.draft !== 16 });
  const hints = [...(input.trackHints ?? [])];
  if (hints.length > 4 || new Set(hints).size !== hints.length) throw new Error('Probe permits at most four distinct track names');
  hints.forEach(checkedText);
  hints.forEach(name => validateFullTrackName(namespace, new TextEncoder().encode(name), { allowEmptyNamespace: input.draft !== 16 }));
  return { url: url.href, namespace: [...input.namespace], draft: input.draft, trackHints: hints, policy: input.policy ?? 'strict' };
}

/** Explicit Start owns the transport and collection; views never own either. */
export function createProbeRunner(options: ProbeOptions): ProbeRunner {
  encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION, kind: 'discover', ownerId: options.ownerId, requestId: 'probe-owner' });
  const attemptMs = options.attemptTimeoutMs ?? 10000, closeMs = options.closeTimeoutMs ?? 3000;
  for (const n of [attemptMs, closeMs]) if (!Number.isSafeInteger(n) || n < 1 || n > 60000) throw new Error('Invalid Probe timeout');
  let disposed = false;
  let current: { stopped: () => boolean; run: ProbeRun; release: () => void } | null = null;
  return {
    start(input) {
      if (disposed) throw new Error('Probe runner is disposed');
      if (current && !current.stopped()) throw new Error('A Probe run is already active');
      const config = checkedConfig(input);
      current?.release();
      const abort = new AbortController();
      const protocols = [`moqt-${config.draft}`];
      const sessionId = crypto.randomUUID(), attemptId = crypto.randomUUID();
      const source: SourceDescriptor = { sourceId: 'probe', runId: crypto.randomUUID(), kind: 'probe',
        label: `Probe · ${new URL(config.url).host}`, exposure: null, synthetic: false,
        capabilities: ['session', 'requests', 'objects', 'group-bounds', 'control', 'metrics'], modules: [] };
      const capture = new DiagnosticCapture({ source, clock: options.clock, allowEndedAttachments: true,
        onActiveChange(active) { if (!active) queueMicrotask(() => { void stop().catch(() => {}); }); },
      });
      // The owner retains evidence while the view is hidden or not yet bound.
      const keeper = capture.attach(options.ownerId, 'probe-collection').lease;
      const emit = (fact: Fact, lane: 'dense' | 'sparse' = 'sparse') => { capture.emit(fact, lane); keeper.pull(); };
      let transport: (WebTransportLike & { readonly ready?: Promise<unknown> }) | null = null;
      let transportClosed: WebTransportLike['closed'] | null = null;
      let connection: MoqtConnection | null = null;
      const receiptOrigins = new WeakMap<ObjectReceipt, Pick<ObjectReceiptObservation, 'origin' | 'lastObjectId'>>();
      let offReceipts = () => {};
      let adopted = false, rawClosed = false;
      let stopPromise: Promise<void> | null = null;
      let stage: 'dial' | 'setup' | 'subscribe' = 'dial';
      let negotiated: string | null = null;
      let setupStart: number | null = null;
      let setupDuration: number | null = null;
      let unattributedDeliveries = 0;
      const reportUnattributed = () => emit({ kind: 'metric', name: 'diagnostic_unattributed_deliveries', sessionId, trackId: null,
        value: unattributedDeliveries, unavailable: null, unit: 'count', windowMs: null, uncertaintyMs: null,
        definition: 'Application object callbacks without an observed transport receipt origin in this Probe run; not missing media Objects' });
      let sequence = 0n, startupComplete = false, failureEmitted = false;
      let closeFinished = false, closeFailed = false;
      const sampleTime = () => {
        try { const time = options.clock.now(); return Number.isFinite(time) && time >= 0 ? time : null; }
        catch { return null; }
      };
      const session = (state: 'dialing' | 'setup' | 'ready' | 'closing' | 'closed' | 'failed') => {
        emit({ kind: 'session', sessionId, state, transport: 'webtransport', endpoint: { origin: new URL(config.url).origin, path: new URL(config.url).pathname },
          draft: config.draft, draftEvidence: negotiated ? 'transport' : 'configured', offeredProtocols: protocols, negotiatedProtocol: negotiated,
          setupDurationMs: setupDuration,
          maxRequestId: { value: null, unavailable: config.draft === 16 ? 'not-observed' : 'not-applicable' } });
      };
      const failure = (at: 'dial' | 'setup' | 'subscribe' | 'stream' | 'teardown', outcome: 'error' | 'cancelled' | 'timeout') => emit({
        kind: 'failure', stage: at, outcome, attribution: outcome === 'error' ? 'unknown' : 'local', sessionId,
        requestId: null, attemptId, message: `Probe ${at} ${outcome}`,
        code: outcome === 'timeout' ? 'probe-timeout' : null, codeSpace: outcome === 'timeout' ? 'local' : null });
      const rawClose = () => {
        if (!transport || adopted || rawClosed) return;
        rawClosed = true; try { transport.close(); } catch { /* Closed promise supplies teardown evidence. */ }
      };
      function bounded<T>(work: Promise<T>, ms: number, cancellable: boolean): Promise<T> {
        return new Promise((resolve, reject) => {
          const cancel = () => finish(() => reject(new Error('Probe cancelled')));
          const timer = setTimeout(() => finish(() => reject(new ProbeTimeout())), ms);
          const finish = (fn: () => void) => { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); fn(); };
          if (cancellable) abort.signal.addEventListener('abort', cancel, { once: true });
          work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
          if (cancellable && abort.signal.aborted) cancel();
        });
      }
      function stop(): Promise<void> {
        if (stopPromise) return stopPromise;
        if (!startupComplete && !failureEmitted) { failureEmitted = true; failure(stage, 'cancelled'); }
        abort.abort();
        stopPromise = (async () => {
          try {
            session('closing');
            if (connection) await bounded(connection.close(), closeMs, false); else rawClose();
            if (transport && transportClosed === null) throw new Error('Probe transport has no observable closed promise');
            // W3C WebTransport §6.1 [[Closed]] rejects for a terminated failed
            // session. Settlement proves termination; a pending promise does not.
            if (transportClosed) await bounded(transportClosed.then(() => undefined, () => undefined), closeMs, false);
            session('closed');
          } catch (error) { closeFailed = true; failure('teardown', error instanceof ProbeTimeout ? 'timeout' : 'error'); throw error; }
          finally { offReceipts(); closeFinished = true; capture.dispose(); }
        })();
        void stopPromise.catch(() => {});
        return stopPromise;
      }
      const ready = Promise.resolve().then(async () => {
        if (abort.signal.aborted) throw new Error('Probe cancelled');
        if (!capture.active) throw new Error('Probe diagnostic clock is unavailable');
        reportUnattributed();
        session('dialing');
        emit({ kind: 'dial_attempt', attemptId, state: 'started', offeredProtocols: protocols, negotiatedProtocol: null, policy: config.policy! });
        const pending = Promise.resolve().then(() => options.transportFactory({ url: config.url, protocols: [...protocols], signal: abort.signal })).then(value => {
          transport = value;
          try {
            const closed = value.closed;
            if (!closed || typeof closed.then !== 'function') throw new Error('Probe transport has no closed promise');
            transportClosed = closed; void closed.catch(() => {});
            return value;
          } finally { if (abort.signal.aborted) rawClose(); }
        });
        const value = await bounded(pending, attemptMs, true);
        if (value.kind !== undefined && value.kind !== 'webtransport') throw new Error('Probe requires WebTransport');
        await bounded(value.ready ?? Promise.resolve(), attemptMs, true);
        negotiated = value.protocol || null;
        if ((negotiated !== null && negotiated !== protocols[0]) || (negotiated === null && config.policy === 'strict')) throw new Error('Probe protocol was not observed or did not match the requested draft');
        emit({ kind: 'dial_attempt', attemptId, state: 'ready', offeredProtocols: protocols, negotiatedProtocol: negotiated, policy: config.policy! });
        stage = 'setup'; setupStart = sampleTime(); session('setup');
        connection = new MoqtConnection(config.draft); adopted = true;
        offReceipts = connection.observeObjectReceipts(event => { receiptOrigins.set(event.receipt, { origin: event.origin, lastObjectId: event.lastObjectId }); });
        const remoteFailure = () => {
          if (abort.signal.aborted) return;
          if (!failureEmitted) { failureEmitted = true; failure(startupComplete ? 'stream' : stage, 'error'); }
          void stop().catch(() => {});
        };
        connection.onClose = remoteFailure;
        connection.onError = remoteFailure;
        connection.onQlogEvent = event => {
          if (abort.signal.aborted || (event.type !== 'control_message_created' && event.type !== 'control_message_parsed')) return;
          const requestId = 'requestId' in event.message ? String(event.message.requestId) : null;
          emit({ kind: 'control', sessionId, streamId: null, requestId, messageType: event.message.type,
            direction: event.type === 'control_message_created' ? 'sent' : 'received' }, 'dense');
        };
        await bounded(connection.connect(value, config.draft === 16 ? { maxRequestId: varint(100) } : {}), attemptMs, true);
        const setupEnd = sampleTime();
        if (setupEnd !== null && setupStart !== null && setupEnd >= setupStart) setupDuration = setupEnd - setupStart;
        stage = 'subscribe';
        for (const [index, name] of config.trackHints!.entries()) {
          const trackId = `track-${index}`;
          const namespace = config.namespace.map(f => new TextEncoder().encode(f));
          const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
          emit({ kind: 'track', trackId, identity: { namespace: namespace.map(hex), name: hex(new TextEncoder().encode(name)) },
            displayName: name, mediaType: 'unknown', codec: null, packaging: null });
          let requestId: string | null = null;
          const sub = await bounded(connection.subscribeTrack(namespace, new TextEncoder().encode(name), {
            onObject(object) {
              if (abort.signal.aborted || sequence === 0xffffffffffffffffn) return;
              const token = connection?.objectReceiptFor(object);
              const origin = token && receiptOrigins.get(token);
              if (!origin) {
                if (unattributedDeliveries < Number.MAX_SAFE_INTEGER) unattributedDeliveries++;
                reportUnattributed();
                return; // No identity proof: disclose coverage, never infer origin or a delivery id.
              }
              if (origin.origin === 'group-end') {
                if (origin.lastObjectId === null) return;
                const exclusive = origin.lastObjectId < 0xffffffffffffffffn;
                emit({ kind: 'group_bound', sessionId, trackAlias: String(object.trackAlias), groupId: String(object.groupId),
                  objectId: String(exclusive ? origin.lastObjectId + 1n : origin.lastObjectId), bound: exclusive ? 'exclusive' : 'inclusive', evidence: 'end-of-group' }, 'dense');
                return;
              }
              emit({ kind: 'object', deliveryId: `delivery-${++sequence}`, sessionId, requestId, trackId,
                trackAlias: String(object.trackAlias), groupId: String(object.groupId), objectId: String(object.objectId),
                subgroupId: String(object.subgroupId), streamId: null,
                payloadBytes: object.kind === 'data' ? object.payload.byteLength : 0,
                objectStatus: object.kind === 'gap' ? String(object.status) : '0', independence: 'unknown' }, 'dense');
            },
          }), attemptMs, true);
          requestId = String(sub.requestId);
          emit({ kind: 'request', sessionId, requestId, requestType: 'SUBSCRIBE', trackId, trackAlias: String(sub.trackAlias), state: 'accepted' });
        }
        startupComplete = true; session('ready');
      }).catch(async error => {
        if (!failureEmitted) {
          failureEmitted = true;
          failure(stage, abort.signal.aborted ? 'cancelled' : error instanceof ProbeTimeout ? 'timeout' : 'error');
          if (stage === 'dial') emit({ kind: 'dial_attempt', attemptId,
            state: abort.signal.aborted ? 'cancelled' : 'failed', offeredProtocols: protocols,
            negotiatedProtocol: negotiated, policy: config.policy! });
        }
        try { await stop(); } catch { /* The teardown failure has its own fact. */ }
        throw error;
      });
      void ready.catch(() => {});
      const run: ProbeRun = { source: capture.descriptor, capture, ready, stop };
      current = { run, stopped: () => closeFinished && !closeFailed, release: () => keeper.close() };
      return run;
    },
    async dispose() {
      disposed = true;
      try { await current?.run.stop(); } finally { current?.release(); current = null; }
    },
  };
}
