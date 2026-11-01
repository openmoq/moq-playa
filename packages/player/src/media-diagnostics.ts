import type { MoqtConnection, ObjectReceipt } from '@openmoq/webtransport';
import type { MediaAppendObservation, MediaSourceLike, VideoRendererLike, AudioOutputLike, VideoFrameObservation, AudioScheduleObservation } from './interfaces.js';
import type { ObjectRoutingContext } from './subscription-manager.js';
import type { MediaDiagnosticHost, MediaDiagnosticRuntime, MediaStageObservation, MediaStageObserver } from './media-diagnostic-types.js';
export type { MediaDiagnosticRuntime, MediaDiagnosticsFactory, MediaStageObservation, MediaStageObserver } from './media-diagnostic-types.js';

/** Explicit optional implementation; the ordinary player entry does not import it. */
export function createMediaDiagnostics(host: MediaDiagnosticHost, emit: MediaStageObserver,
  limits: { maxUnits?: number; maxConnections?: number } = {}): MediaDiagnosticRuntime {
  const maxUnits = limits.maxUnits ?? 1024, maxConnections = limits.maxConnections ?? 8;
  for (const limit of [maxUnits, maxConnections]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Expected positive safe diagnostic limits');
  }
  let disposed = false, losses = 0, unobservable = 0, unattributed = 0;
  const seen = new WeakSet<object>();
  const connections = new Map<MoqtConnection, () => void>();
  interface Binding { readonly source: MediaSourceLike; pending: number; off?: () => void }
  type OutputKind = 'video' | 'audio';
  type OutputTarget = VideoRendererLike | AudioOutputLike;
  interface OutputBinding { readonly kind: OutputKind; readonly target: OutputTarget; pending: number; off?: () => void }
  const outputBindings = { video: new Map<OutputTarget, OutputBinding>(), audio: new Map<OutputTarget, OutputBinding>() };
  const outputTargets: Record<OutputKind, OutputTarget | null> = { video: null, audio: null };
  const decoded = { video: 0, audio: 0 };
  const refused = { reconstructed: 0, video: 0, audio: 0 };
  const unsupported = { video: 0, audio: 0 };
  const release = (off: (() => void) | undefined): void => {
    try { off?.(); } catch { /* A custom unsubscribe cannot prevent other diagnostic cleanup. */ }
  };
  const bindings = new Map<MediaSourceLike, Binding>();
  const units = new Map<object, { inputs: readonly ObjectRoutingContext[]; kind: 'reconstructed' | OutputKind; binding: Binding | OutputBinding | null; scheduled: boolean }>();
  let source: MediaSourceLike | null = null;
  const notify = (event: MediaStageObservation): void => {
    if (disposed) return;
    try { const result = emit({ ...event, inputs: [...event.inputs] }); if (result) void Promise.resolve(result).catch(() => {}); }
    catch { /* Optional metadata never changes media delivery. */ }
  };
  const retireBinding = (binding: Binding | OutputBinding): void => {
    if ('target' in binding) {
      const map = outputBindings[binding.kind];
      if (binding.target === outputTargets[binding.kind] || binding.pending !== 0 || map.get(binding.target) !== binding) return;
      map.delete(binding.target); release(binding.off); return;
    }
    if (binding.source === source || binding.pending !== 0 || bindings.get(binding.source) !== binding) return;
    bindings.delete(binding.source); release(binding.off);
  };
  const takeUnit = (unit: object) => {
    const record = units.get(unit);
    if (!record) return;
    units.delete(unit);
    if (record.binding) { record.binding.pending--; retireBinding(record.binding); }
    return record;
  };
  const finish = (event: MediaAppendObservation, binding: Binding): void => {
    if (disposed || bindings.get(binding.source) !== binding) return;
    const record = units.get(event.token);
    if (!record || record.binding !== binding) return;
    takeUnit(event.token);
    if (event.state === 'unavailable') { losses++; return; }
    notify({ unit: event.token, inputs: record.inputs, stage: event.state, reason: event.reason });
  };
  const finishOutput = (event: VideoFrameObservation | AudioScheduleObservation, binding: OutputBinding): void => {
    if (disposed || outputBindings[binding.kind].get(binding.target) !== binding) return;
    const record = units.get(event.token);
    if (!record || record.binding !== binding) return;
    if (event.state === 'scheduled') {
      if (record.scheduled) return;
      record.scheduled = true;
      notify({ unit: event.token, inputs: record.inputs, stage: 'scheduled', reason: null }); return;
    }
    if (event.state === 'released' && binding.kind === 'audio') { takeUnit(event.token); return; }
    if (event.state === 'unavailable' && binding.kind === 'video') { takeUnit(event.token); losses++; return; }
    if (event.state !== 'discarded' && !(event.state === 'presented' && binding.kind === 'video')) return;
    takeUnit(event.token);
    notify({ unit: event.token, inputs: record.inputs, stage: event.state, reason: event.reason });
  };
  type OutputAdmission = { readonly kind: 'observed'; readonly binding: OutputBinding }
    | { readonly kind: 'unsupported' | 'unavailable' };
  const bindOutput = (kind: OutputKind, target: OutputTarget): OutputAdmission => {
    const map = outputBindings[kind], previous = outputTargets[kind];
    outputTargets[kind] = target;
    if (previous && previous !== target) { const old = map.get(previous); if (old) retireBinding(old); }
    if (disposed || outputTargets[kind] !== target) return { kind: 'unavailable' };
    const existing = map.get(target);
    if (existing) return existing.off ? { kind: 'observed', binding: existing } : { kind: 'unavailable' };
    const binding: OutputBinding = { kind, target, pending: 0 };
    let remove: (() => void) | undefined;
    try {
      // Reserve before custom adapter code can reenter registration or disposal.
      map.set(target, binding);
      if (kind === 'video') {
        const video = target as VideoRendererLike;
        if (typeof video.observeFrames !== 'function') { map.delete(target); return { kind: 'unsupported' }; }
        remove = video.observeFrames(event => finishOutput(event, binding));
      } else {
        const audio = target as AudioOutputLike;
        if (typeof audio.observeSchedules !== 'function') { map.delete(target); return { kind: 'unsupported' }; }
        remove = audio.observeSchedules(event => finishOutput(event, binding));
      }
      if (typeof remove !== 'function') throw new TypeError('Invalid output observation cleanup');
      if (disposed || map.get(target) !== binding || outputTargets[kind] !== target) {
        if (map.get(target) === binding) map.delete(target);
        release(remove); return { kind: 'unavailable' };
      }
      binding.off = remove;
      return { kind: 'observed', binding };
    } catch {
      if (map.get(target) === binding) map.delete(target);
      release(remove); return { kind: 'unavailable' };
    }
  };
  const offConnections = host.observeConnections(event => {
    if (disposed) return;
    const conn = event.connection;
    if (event.kind === 'retired') { const off = connections.get(conn); connections.delete(conn); release(off); return; }
    if (connections.has(conn)) return;
    if (connections.size >= maxConnections) { losses++; return; }
    // Reserve before a host callback can re-enter the lifecycle.
    connections.set(conn, () => {});
    const off = conn.observeObjectReceipts(event => {
      if (!disposed && connections.has(conn) && event.origin !== 'group-end') seen.add(event.receipt);
    });
    if (disposed || !connections.has(conn)) release(off); else connections.set(conn, off);
  });
  return {
    get decodedVideoCount() { return decoded.video; },
    get decodedAudioCount() { return decoded.audio; },
    get evidenceLossCount() { return losses; },
    get unattributedInputCount() { return unattributed; },
    get unobservableAppendCount() { return unobservable; },
    get unobservableVideoCount() { return unsupported.video; },
    get unobservableAudioCount() { return unsupported.audio; },
    get refusedReconstructionCount() { return refused.reconstructed; },
    get refusedVideoCount() { return refused.video; },
    get refusedAudioCount() { return refused.audio; },
    decoded(kind, input, target) {
      if (disposed) return;
      // Output is observed even if location identity or unit admission is unavailable.
      if (decoded[kind] < Number.MAX_SAFE_INTEGER) decoded[kind]++;
      if (input === undefined || !seen.has(input)) { unattributed++; return; }
      const admission = bindOutput(kind, target);
      if (disposed) return;
      const inputs = [input as ObjectRoutingContext];
      // A target with no observation support cannot ever finish a retained unit.
      // Truthful decoded evidence is still available without consuming capacity.
      if (admission.kind !== 'observed') {
        if (admission.kind === 'unsupported') unsupported[kind]++; else losses++;
        notify({ unit: Object.freeze({}), inputs, stage: 'decoded', reason: null }); return;
      }
      if (units.size >= maxUnits) { refused[kind]++; losses++; return; }
      const unit = Object.freeze({});
      admission.binding.pending++;
      units.set(unit, { inputs, kind, binding: admission.binding, scheduled: false });
      notify({ unit, inputs, stage: 'decoded', reason: null });
      return !disposed && units.has(unit) ? unit : undefined;
    },
    capture(connection, input) {
      if (disposed || ('kind' in input ? input.kind !== 'data' : input.status !== undefined)) return;
      const conn = connection === undefined ? host.currentConnection : connection;
      if (!conn || !connections.has(conn as MoqtConnection)) return;
      const receipt: ObjectReceipt | undefined = (conn as MoqtConnection).objectReceiptFor(input);
      return receipt && seen.has(receipt) ? receipt : undefined;
    },
    discarded(context, reason) {
      if (!disposed && seen.has(context)) notify({ unit: null, inputs: [context], stage: 'discarded', reason });
    },
    reconstruct(inputs) {
      if (disposed || inputs.length === 0) return;
      if (inputs.length > 32) { refused.reconstructed++; losses++; return; }
      const known: ObjectRoutingContext[] = [];
      for (const input of inputs) {
        if (input === undefined || !seen.has(input)) unattributed++;
        else known.push(input);
      }
      const proven = [...new Set(known)];
      if (proven.length === 0) return;
      if (units.size >= maxUnits) { refused.reconstructed++; losses++; return; }
      const unit = Object.freeze({});
      units.set(unit, { inputs: proven, kind: 'reconstructed', binding: null, scheduled: false });
      notify({ unit, inputs: proven, stage: 'reconstructed', reason: null });
      return !disposed && units.has(unit) ? unit : undefined;
    },
    bindMediaSource(next) {
      if (disposed || source === next) return;
      const previous = source; source = next;
      if (previous) { const old = bindings.get(previous); if (old) retireBinding(old); }
      if (disposed || source !== next || !next?.observeAppends || bindings.has(next)) return;
      const binding: Binding = { source: next, pending: 0 };
      bindings.set(next, binding);
      const remove = next.observeAppends(event => finish(event, binding));
      if (disposed || bindings.get(next) !== binding) release(remove); else binding.off = remove;
    },
    appendToken(unit, target) {
      const record = units.get(unit);
      if (disposed || !record) return;
      if (record.kind !== 'reconstructed' || record.binding) { losses++; return; }
      if (source !== target) { takeUnit(unit); losses++; return; }
      const binding = bindings.get(target);
      if (!binding?.off) { takeUnit(unit); unobservable++; return; }
      record.binding = binding; binding.pending++;
      return unit;
    },
    discardUnit(unit, reason) {
      if (disposed) return;
      const record = takeUnit(unit); if (!record) return;
      const { inputs } = record;
      notify({ unit, inputs, stage: 'discarded', reason });
    },
    dispose() {
      if (disposed) return;
      disposed = true; source = null; outputTargets.video = null; outputTargets.audio = null;
      // Release ownership first: unsubscribe callbacks may reenter completion or disposal.
      const remove = [offConnections, ...[...bindings.values()].map(binding => binding.off),
        ...[...outputBindings.video.values(), ...outputBindings.audio.values()].map(binding => binding.off), ...connections.values()];
      bindings.clear(); outputBindings.video.clear(); outputBindings.audio.clear(); connections.clear(); units.clear();
      for (const off of remove) release(off);
    },
  };
}
