import { createMediaDiagnostics } from '@openmoq/player/diagnostics';
import type { MediaStageObservation, PlayerDiagnosticFacade, PlayerDiagnosticSource, PlayerConnectionObservation, PlayerDiagnosticConnection } from '@openmoq/player';
import type { QlogEvent } from '@openmoq/transport';
import type { ObjectReceiptObservation, ObjectReceiptDiscard } from '@openmoq/webtransport';
import { TraceRecorder } from '@openmoq/transport/trace-recorder';
import type { Fact, SourceDescriptor } from '@openmoq/devtools-protocol';
import { DiagnosticCapture } from './capture.js';
import type { CaptureLimits } from './types.js';
import type { DiagnosticRegistry, DiagnosticRecorder } from './registry.js';

export interface PlayerVideoObservation {
  readonly currentTime: number;
  readonly paused?: boolean;
  readonly seeking?: boolean;
  readonly ownerDocument?: { readonly visibilityState: string };
  requestVideoFrameCallback?(callback: (now: number, metadata: { readonly mediaTime: number; readonly presentedFrames: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
  readonly buffered: { readonly length: number; start(index: number): number; end(index: number): number };
}
export interface PlayerDiagnosticsOptions {
  readonly registry: DiagnosticRegistry;
  readonly exposure: 'development' | 'production';
  readonly clock?: { readonly id: string; readonly now: () => number };
  readonly video?: PlayerVideoObservation;
  readonly recording?: boolean;
  readonly limits?: Partial<CaptureLimits>;
  readonly modules?: SourceDescriptor['modules'];
}
export interface PlayerDiagnosticsInstallation {
  readonly source: SourceDescriptor;
  dispose(): void;
}
type MoqtConnection = PlayerDiagnosticConnection['connection'];
interface Context {
  readonly connection: MoqtConnection;
  readonly id: string;
  readonly endpoint: { readonly origin: string; readonly path: string } | null;
  readonly remove: () => void;
  binding: { readonly kind: 'webtransport' | 'quic'; readonly protocol: string | null } | null;
  setupStart: number | null;
  setupDuration: number | null;
  state: string | null;
  retired: boolean;
}
const instances = new WeakMap<PlayerDiagnosticSource, { id: string; installed: WeakMap<DiagnosticRegistry, PlayerDiagnosticsInstallation> }>();
const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const utf8 = new TextEncoder();
const noop = () => {};
const MAX_CONTEXTS = 8, MAX_TRACKS = 512;
const RECEIVE_WINDOW_MS = 1000, RECEIVE_SAMPLES = 6;

/** Explicit app-side opt-in. This entry is deliberately absent from the package root. */
export function installPlayerDiagnostics(target: PlayerDiagnosticSource | PlayerDiagnosticFacade, options: PlayerDiagnosticsOptions): PlayerDiagnosticsInstallation {
  const player = 'diagnosticSource' in target ? target.diagnosticSource : target;
  if (options.exposure !== 'development' && options.exposure !== 'production') throw new Error('Explicit diagnostic exposure is required');
  if (options.registry.sourceKind !== 'attached') throw new Error('Player diagnostics require an attached-source registry, not a Probe registry');
  if (player.diagnosticSnapshot().destroyed) throw new Error('Cannot observe a destroyed player');
  let instance = instances.get(player);
  if (!instance) { instance = { id: crypto.randomUUID(), installed: new WeakMap() }; instances.set(player, instance); }
  if (instance.installed.has(options.registry)) throw new Error('Player diagnostics already installed for this engine and registry');
  const clock = options.clock ?? { id: 'performance', now: () => performance.now() };
  const contexts = new Map<MoqtConnection, Context>();
  const trackIds = new Map<string, string>();
  const announcedTracks = new Set<string>();
  let sessionIds = new WeakMap<MoqtConnection, string>();
  let trackIdentityBytes = 0;
  const writers = new Set<(fact: Fact) => void>();
  const stateCache = new Map<string, { text: string; bytes: number }>();
  let stateCacheBytes = 0;
  let capture: DiagnosticCapture, unregister = noop, connectionOff = noop, mediaOff = noop;
  let deliveries = new WeakMap<object, string>(), units = new WeakMap<object, string>();
  let unitSequence = 0n, unmappedStages = 0;
  let active = false, disposed = false, epoch = 0, delivery = 0n, trackSequence = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let receiveSamples: Array<{ time: number; bytes: number }> = [];
  let started = player.state !== 'idle';
  let observationDrops = 0;
  let frameHandle: number | undefined;
  let lastPresentation: { receivedAt: number; mediaTime: number; frames: number } | null = null;
  const removers: Array<() => void> = [];

  const emit = (fact: Fact, lane: 'dense' | 'sparse' = 'sparse') => {
    if (!active || disposed) return;
    const key = fact.kind === 'session' ? JSON.stringify([fact.kind, fact.sessionId])
      : fact.kind === 'request' ? JSON.stringify([fact.kind, fact.sessionId, fact.requestId])
        : fact.kind === 'track' ? JSON.stringify([fact.kind, fact.trackId]) : null;
    if (key !== null) {
      const text = JSON.stringify(fact), old = stateCache.get(key);
      if (old?.text === text) return;
      if (old) { stateCache.delete(key); stateCacheBytes -= old.bytes; }
      const bytes = utf8.encode(text).byteLength + utf8.encode(key).byteLength;
      if (bytes <= 524288) {
        while (stateCache.size >= 2048 || stateCacheBytes + bytes > 524288) {
          const oldest = stateCache.entries().next().value!;
          stateCache.delete(oldest[0]); stateCacheBytes -= oldest[1].bytes;
        }
        stateCache.set(key, { text, bytes }); stateCacheBytes += bytes;
      }
    }
    capture.emit(fact, lane);
    for (const write of writers) { try { write(fact); } catch { /* Recording cannot affect playback. */ } }
  };
  const metric = (name: string, value: number | null, unit: 'ms' | 'seconds' | 'bytes' | 'bps' | 'count', definition: string, windowMs: number | null = null,
    unavailable: 'unsupported' | 'not-observed' = 'unsupported') => {
    const available = value !== null && Number.isFinite(value);
    emit({ kind: 'metric', name, sessionId: null, trackId: null, value: available ? value : null,
      unavailable: available ? null : unavailable, unit, definition, windowMs, uncertaintyMs: null });
  };
  const stop = () => {
    active = false; epoch++;
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    if (frameHandle !== undefined) {
      try { options.video?.cancelVideoFrameCallback?.(frameHandle); } catch { /* Optional platform cleanup. */ }
      frameHandle = undefined;
    }
    lastPresentation = null;
    mediaOff(); mediaOff = noop;
    connectionOff(); connectionOff = noop;
    for (const context of contexts.values()) context.remove();
    contexts.clear(); announcedTracks.clear(); stateCache.clear(); stateCacheBytes = 0; receiveSamples = [];
  };
  const guarded = (run: () => void) => {
    try { run(); } catch { stop(); capture.dispose(); }
  };
  const track = (fields: readonly Uint8Array[], name: Uint8Array, display?: { mediaType: string | null; codec: string | null; packaging: string | null }): string | null => {
    const identity = { namespace: fields.map(hex), name: hex(name) };
    const key = JSON.stringify([identity.namespace, identity.name]);
    let id = trackIds.get(key);
    if (!id) {
      const bytes = utf8.encode(key).byteLength;
      if (trackIds.size >= MAX_TRACKS || trackIdentityBytes + bytes > 262144) { observationDrops++; return null; }
      trackIdentityBytes += bytes;
      id = `track-${++trackSequence}`; trackIds.set(key, id);
    }
    if (announcedTracks.has(id) && !display) return id;
    announcedTracks.add(id);
    emit({ kind: 'track', trackId: id, identity, displayName: new TextDecoder().decode(name),
      mediaType: display?.mediaType === 'video' || display?.mediaType === 'audio' || display?.mediaType === 'text'
        ? display.mediaType : display?.mediaType === 'eventtimeline' ? 'event' : 'unknown',
      codec: display?.codec ?? null, packaging: display?.packaging ?? null });
    return id;
  };
  const syncSession = (context: Context) => {
    context.binding = context.connection.transportInfo ?? context.binding;
    if (!context.binding) return; // A constructed connection is not yet proof of a transport binding.
    const state = context.connection.session.state;
    const shown = state === 'closed' ? 'closed' : state === 'draining' ? 'closing'
      : state === 'established' ? 'ready' : state === 'setup_pending' ? 'setup' : 'dialing';
    if (shown === 'ready' && context.setupStart !== null && context.setupDuration === null) {
      const elapsed = clock.now() - context.setupStart;
      if (Number.isFinite(elapsed) && elapsed >= 0) context.setupDuration = elapsed;
    }
    context.state = shown;
    const draft = context.connection.draftVersion;
    const expectedProtocol = draft === 14 ? 'moq-00' : `moqt-${draft}`;
    emit({ kind: 'session', sessionId: context.id, state: shown, transport: context.binding.kind, endpoint: context.endpoint,
      draft, draftEvidence: context.binding.protocol === expectedProtocol ? 'transport' : 'configured', offeredProtocols: [], negotiatedProtocol: context.binding.protocol,
      setupDurationMs: context.setupDuration,
      maxRequestId: draft === 18 || draft === 22 || draft === 23 ? { value: null, unavailable: 'not-applicable' }
        : state === 'established' || state === 'draining' ? { value: String(context.connection.session.peerMaxRequestId), unavailable: null }
          : { value: null, unavailable: 'not-observed' } });
  };
  const bindingFor = (context: Context, alias: bigint) => {
    // Alias ownership is proven by this session's actual accepted subscriptions,
    // not by a same-numbered request/alias in another connection's inventory.
    const subscriptions = context.connection.session.getSubscriberRequestsForAlias(alias)
      .filter(sub => context.connection.session.getSubscription(sub.requestId) === sub && !sub.isPublishInitiated
        && sub.trackAlias === alias && sub.trackNamespace !== undefined && sub.trackName !== undefined);
    const sub = subscriptions[0];
    if (!sub) return { requestId: null, trackId: null };
    const trackId = track(sub.trackNamespace!, sub.trackName!);
    for (const owner of subscriptions) emit({ kind: 'request', sessionId: context.id, requestId: String(owner.requestId),
      requestType: 'SUBSCRIBE', trackId, trackAlias: String(alias), state: 'accepted' });
    return { requestId: subscriptions.length === 1 ? String(sub.requestId) : null, trackId };
  };
  const receipt = (context: Context, event: ObjectReceiptObservation) => {
    if (!active || disposed) return;
    // FETCH has request/stream identity, not a subscription alias binding.
    if (event.trackAlias === null) return;
    if (event.origin === 'group-end') {
      if (event.lastObjectId === null) return; // Empty subgroup: no last Object to bound.
      const exclusive = event.lastObjectId < 0xffffffffffffffffn;
      emit({ kind: 'group_bound', sessionId: context.id, trackAlias: String(event.trackAlias), groupId: String(event.groupId),
        objectId: String(exclusive ? event.lastObjectId + 1n : event.lastObjectId), bound: exclusive ? 'exclusive' : 'inclusive', evidence: 'end-of-group' }, 'dense');
      return;
    }
    const binding = bindingFor(context, event.trackAlias);
    const deliveryId = `delivery-${++delivery}`;
    deliveries.set(event.receipt, deliveryId);
    emit({ kind: 'object', deliveryId, sessionId: context.id, ...binding,
      trackAlias: String(event.trackAlias), groupId: String(event.groupId), objectId: String(event.objectId), subgroupId: event.subgroupId === null ? null : String(event.subgroupId),
      streamId: null, payloadBytes: event.payloadBytes, objectStatus: String(event.objectStatus), independence: 'unknown' }, 'dense');
  };
  const discard = (_context: Context, event: ObjectReceiptDiscard) => {
    const deliveryId = deliveries.get(event.receipt);
    if (deliveryId !== undefined) emit({ kind: 'stage', deliveryId, unitId: null, stage: 'discarded', reason: event.reason }, 'dense');
  };
  const mediaStage = (event: MediaStageObservation) => {
    if (!active || disposed) return;
    let unitId: string | null = null;
    if (event.unit) {
      unitId = units.get(event.unit) ?? `unit-${++unitSequence}`;
      units.set(event.unit, unitId);
    }
    for (const input of event.inputs) {
      const deliveryId = deliveries.get(input);
      if (deliveryId === undefined) { unmappedStages++; continue; }
      emit({ kind: 'stage', deliveryId, unitId, stage: event.stage, reason: event.reason }, 'dense');
    }
  };
  const qlog = (context: Context, event: QlogEvent) => {
    if (!active || disposed) return;
    switch (event.type) {
      case 'control_message_created':
      case 'control_message_parsed': {
        const message = event.message;
        emit({ kind: 'control', sessionId: context.id, streamId: null,
          requestId: 'requestId' in message && message.requestId !== undefined ? String(message.requestId) : null,
          messageType: message.type, direction: event.type === 'control_message_created' ? 'sent' : 'received' }, 'dense');
        if (event.type === 'control_message_created' && (message.type === 'CLIENT_SETUP' || message.type === 'SETUP')) context.setupStart = clock.now();
        const currentEpoch = epoch;
        // Parsed is not accepted. Let synchronous session validation finish,
        // then read its actual state rather than declaring success from bytes.
        queueMicrotask(() => { if (active && currentEpoch === epoch) guarded(() => syncSession(context)); });
        break;
      }

    }
  };
  const observe = (event: PlayerConnectionObservation) => {
    if (!active || disposed) return;
    const existing = contexts.get(event.connection);
    if (event.kind === 'retired') {
      if (existing) { existing.retired = true; syncSession(existing); }
      return;
    }
    if (existing) return;
    if (contexts.size >= MAX_CONTEXTS) {
      const old = [...contexts.values()].find(context => context.retired && context.connection.session.state === 'closed');
      if (!old) { observationDrops++; return; }
      old.remove(); contexts.delete(old.connection);
    }
    let context: Context;
    const offQlog = event.connection.observeQlogEvents(event => guarded(() => qlog(context, event)));
    const offReceipts = event.connection.observeObjectReceipts(event => guarded(() => receipt(context, event)));
    const offDiscards = event.connection.observeObjectDiscards(event => guarded(() => discard(context, event)));
    const remove = () => { offQlog(); offReceipts(); offDiscards(); };
    let sessionId = sessionIds.get(event.connection);
    if (!sessionId) { sessionId = crypto.randomUUID(); sessionIds.set(event.connection, sessionId); }
    context = { connection: event.connection, id: sessionId, endpoint: event.endpoint, remove,
      binding: null, setupStart: null, setupDuration: null, state: null, retired: false };
    contexts.set(event.connection, context); syncSession(context);
  };
  const syncSnapshot = () => {
    const snapshot = player.diagnosticSnapshot();
    for (const connection of snapshot.connections) observe({ kind: 'available', ...connection });
    for (const item of snapshot.tracks) track(item.namespace.map(field => utf8.encode(field)), utf8.encode(item.name), item);
    for (const sub of snapshot.subscriptions) {
      const context = contexts.get(sub.connection); if (!context) continue;
      const id = track(sub.namespace.map(field => utf8.encode(field)), utf8.encode(sub.name));
      emit({ kind: 'request', sessionId: context.id, requestId: String(sub.requestId), requestType: 'SUBSCRIBE', trackId: id,
        trackAlias: sub.trackAlias === null ? null : String(sub.trackAlias), state: sub.trackAlias === null ? 'pending' : 'accepted' });
    }
    return snapshot;
  };
  const sample = () => {
    if (!active || disposed) return;
    const snapshot = syncSnapshot();
    for (const context of contexts.values()) {
      syncSession(context);
      if (context.retired && context.connection.session.state === 'closed') { context.remove(); contexts.delete(context.connection); }
    }
    const stats = player.stats, time = clock.now();
    const last = receiveSamples.at(-1);
    if (!Number.isFinite(stats.bytesReceived) || stats.bytesReceived < 0
      || (last && (stats.bytesReceived < last.bytes || time - last.time > RECEIVE_WINDOW_MS))) receiveSamples = [];
    // Keep the sample bracketing the target boundary: discarding it on a slightly late tick would turn a
    // one-second burst into a false zero. The reported window is the actual sampled span, not an interpolation.
    while (receiveSamples.length > 1 && receiveSamples[1]!.time <= time - RECEIVE_WINDOW_MS) receiveSamples.shift();
    const baseline = receiveSamples[0];
    const window = baseline ? time - baseline.time : 0;
    const receiveRate = baseline && window > 0 ? 8000 * (stats.bytesReceived - baseline.bytes) / window : null;
    if (Number.isFinite(stats.bytesReceived) && stats.bytesReceived >= 0) receiveSamples.push({ time, bytes: stats.bytesReceived });
    if (receiveSamples.length > RECEIVE_SAMPLES) receiveSamples.shift();
    metric('objects_received', stats.objectsReceived, 'count', 'Engine media-object receive counter for this playback run');
    metric('payload_bytes_received', stats.bytesReceived, 'bytes', 'Engine received media payload bytes for this playback run');
    metric('video_decode_submissions', stats.framesDecoded, 'count', 'Video decode commands emitted after transforms and before native dispatch over the engine lifetime; includes calls with no output');
    metric('frames_decoded', snapshot.mediaStages?.decodedVideoCount ?? null, 'count', 'Actual video decoder output callbacks during the engine diagnostic tracker lifetime; unavailable without that callback, including MSE');
    metric('audio_outputs_decoded', snapshot.mediaStages?.decodedAudioCount ?? null, 'count', 'Actual audio decoder output callbacks during the engine diagnostic tracker lifetime; unavailable without that callback, including MSE');
    metric('frames_rendered', stats.framesRendered, 'count', 'Engine-reported render callbacks; not a universal compositor frame count');
    metric('av_skew', stats.avSkewMs, 'ms', 'Measured video capture timestamp minus audible audio playhead; positive means video ahead');
    metric('receive_bitrate', receiveRate, 'bps', 'Media payload receive bitrate between cumulative samples targeting one second; windowMs is the actual span including timer jitter',
      window > 0 ? window : null, 'not-observed');
    metric('end_to_end_latency', null, 'ms', 'Unavailable without a verified sender-to-receiver clock relation');
    metric('arrival_jitter', null, 'ms', 'Unavailable without a declared expected object arrival cadence');
    metric('diagnostic_unattributed_stages', unmappedStages, 'count', 'Stage inputs not observed by this capture lifetime; no delivery identity is inferred');
    metric('diagnostic_unattributed_inputs', snapshot.mediaStages?.unattributedInputCount ?? null, 'count', 'Reconstruction contributors or decoder outputs whose input was not observed in this engine tracker lifetime; no identity is inferred');
    metric('diagnostic_evidence_loss', snapshot.mediaStages?.evidenceLossCount ?? null, 'count', 'Engine diagnostic admission refusals or unproven completions; not missing media');
    metric('diagnostic_unobservable_appends', snapshot.mediaStages?.unobservableAppendCount ?? null, 'count', 'Units whose media adapter cannot report append completion; not media loss');
    metric('diagnostic_refused_reconstructed_units', snapshot.mediaStages?.refusedReconstructionCount ?? null, 'count', 'Reconstruction units refused diagnostic admission; not dropped media');
    metric('diagnostic_refused_video_units', snapshot.mediaStages?.refusedVideoCount ?? null, 'count', 'Video outputs refused diagnostic admission at the shared unit limit; not dropped frames');
    metric('diagnostic_refused_audio_units', snapshot.mediaStages?.refusedAudioCount ?? null, 'count', 'Audio outputs refused diagnostic admission at the shared unit limit; not dropped audio');
    metric('diagnostic_unobservable_video_outputs', snapshot.mediaStages?.unobservableVideoCount ?? null, 'count', 'Decoded video outputs whose renderer cannot report frame outcomes; not media loss');
    metric('diagnostic_unobservable_audio_outputs', snapshot.mediaStages?.unobservableAudioCount ?? null, 'count', 'Decoded audio outputs whose audio adapter cannot report scheduling outcomes; not media loss');
    metric('diagnostic_input_admission_refusals', snapshot.mediaStages?.inputAdmissionRefusalCount ?? null, 'count', 'Pipeline input associations refused diagnostic admission while media remains buffered and decoded normally');
    metric('diagnostic_limit_events', observationDrops, 'count', 'Local mapping evictions or refused diagnostic observations; not a count of missing media objects');
    if (options.video && active) {
      const video = options.video, position = video.currentTime, buffered = video.buffered;
      let ahead: number | null = null;
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= position && position <= buffered.end(i)) { ahead = buffered.end(i) - position; break; }
      }
      metric('video_playhead', position, 'seconds', 'Media element currentTime sampled while diagnostic capture is attached');
      metric('video_buffer_ahead', ahead, 'seconds', 'Buffered range containing the media playhead; no range is unavailable');
      metric('video_presented_frames', lastPresentation?.frames ?? null, 'count', 'presentedFrames from the latest real requestVideoFrameCallback; not object delivery');
      metric('video_frame_media_time', lastPresentation?.mediaTime ?? null, 'seconds', 'Media timestamp from the latest real requestVideoFrameCallback');
      metric('video_frame_age', lastPresentation ? Math.max(0, time - lastPresentation.receivedAt) : null, 'ms', 'Time since the last video-frame callback; background scheduling or pause can delay callbacks');
      metric('video_paused', video.paused === undefined ? null : Number(video.paused), 'count', 'Media element paused state: 1 paused, 0 playing');
      metric('video_seeking', video.seeking === undefined ? null : Number(video.seeking), 'count', 'Media element seeking state: 1 seeking, 0 not seeking');
      metric('document_hidden', video.ownerDocument ? Number(video.ownerDocument.visibilityState !== 'visible') : null, 'count', 'Inspected media document visibility: 1 not visible, 0 visible');
    }
    if (snapshot.destroyed) { stop(); capture.dispose(); }
  };
  const armPresentation = () => {
    const video = options.video;
    if (!active || !video?.requestVideoFrameCallback || !video.cancelVideoFrameCallback) return;
    const currentEpoch = epoch;
    frameHandle = video.requestVideoFrameCallback((_now, metadata) => {
      if (!active || currentEpoch !== epoch) return;
      frameHandle = undefined;
      guarded(() => {
        const receivedAt = clock.now();
        if (Number.isFinite(receivedAt) && Number.isFinite(metadata.mediaTime) && Number.isSafeInteger(metadata.presentedFrames) && metadata.presentedFrames >= 0) {
          lastPresentation = { receivedAt, mediaTime: metadata.mediaTime, frames: metadata.presentedFrames };
        }
        if (active) armPresentation();
      });
    });
  };
  const start = () => {
    if (active || disposed) return;
    active = true; epoch++;
    const off = player.observeConnections(event => guarded(() => observe(event)));
    if (!active) { off(); return; }
    connectionOff = off;
    if (player.observeMediaStages) {
      const currentEpoch = epoch;
      const remove = player.observeMediaStages(event => {
        if (active && epoch === currentEpoch) guarded(() => mediaStage(event));
      }, { createTracker: createMediaDiagnostics });
      if (!active || epoch !== currentEpoch) { remove(); return; }
      mediaOff = remove;
    }
    armPresentation();
    sample();
    if (active) timer = setInterval(() => guarded(sample), 250);
  };
  const recorder = (maxBytes: number): DiagnosticRecorder => {
    const runId = capture.descriptor.runId;
    const trace = new TraceRecorder({ runId, clock: { clock_id: clock.id, clock_type: 'monotonic', now: () => clock.now() }, eventSchemas: [], title: 'Playa DevTools recording',
      limits: { denseMaxBytes: Math.floor(maxBytes / 2), sparseMaxBytes: Math.floor(maxBytes / 4), metadataMaxBytes: Math.floor(maxBytes / 8) } });
    const base = { error: noop, warn: noop, info: noop, debug: noop };
    const sparse = trace.logger(base), dense = trace.logger(base, { lane: 'dense' });
    const write = (fact: Fact) => (fact.kind === 'object' || fact.kind === 'stage' || fact.kind === 'control' ? dense : sparse)
      .info(`[devtools_observation:v1] ${JSON.stringify(fact)}`);
    return {
      start() { trace.start(); trace.declare('trace_capabilities', { source: 'Playa diagnostics', encoding: 'devtools_observation:v1 loglevel text; no media payload or credentials' }); trace.declare('diagnostic_baseline', { facts: [...stateCache.values()].map(entry => JSON.parse(entry.text)) }); writers.add(write); },
      stop() { writers.delete(write); trace.stop(); },
      dump: () => trace.dump(),
      dispose() { writers.delete(write); trace.stop(); trace.clear(); },
    };
  };
  const makeCapture = () => {
    deliveries = new WeakMap(); units = new WeakMap(); unitSequence = 0n; unmappedStages = 0;
    sessionIds = new WeakMap(); trackIds.clear(); announcedTracks.clear(); trackIdentityBytes = 0;
    capture = new DiagnosticCapture({ source: { sourceId: instance!.id, runId: crypto.randomUUID(), kind: 'attached',
      exposure: options.exposure, label: 'Playa', synthetic: false, modules: options.modules ?? [],
      capabilities: ['session', 'requests', 'objects', 'group-bounds', 'object-policy-discards', ...(player.observeMediaStages ? player.mediaStageCapabilities ?? ['cmaf-append-stages'] : []), 'metrics', ...(options.recording === false ? [] : ['recording'])] },
      clock, ...(options.limits ? { limits: options.limits } : {}), onActiveChange(enabled) { if (enabled) guarded(start); else stop(); } });
    unregister = options.registry.register(capture, options.recording === false ? undefined : { createRecorder: ({maxBytes}) => recorder(maxBytes) });
  };
  makeCapture();
  const installation: PlayerDiagnosticsInstallation = {
    get source() { return capture.descriptor; },
    dispose() {
      if (disposed) return;
      disposed = true; stop(); trackIds.clear(); announcedTracks.clear(); removers.forEach(remove => remove());
      capture.dispose(); unregister(); instance!.installed.delete(options.registry);
    },
  };
  instance.installed.set(options.registry, installation);
  removers.push(player.on('session_connecting', () => guarded(() => {
    if (!started) { started = true; return; }
    stop(); capture.dispose(); unregister(); delivery = 0n; trackSequence = 0; observationDrops = 0; makeCapture();
  })));
  // Destruction can suppress a queued final state event. Keep the state probe
  // for diagnostic sources that do not offer the explicit lifetime hook.
  if (player.observeDestroy) removers.push(player.observeDestroy(() => guarded(() => installation.dispose())));
  removers.push(player.on('state_changed', () => guarded(() => { if (player.diagnosticSnapshot().destroyed) installation.dispose(); })));
  return installation;
}
