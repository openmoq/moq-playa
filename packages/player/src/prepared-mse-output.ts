import type { MoqtObject } from '@openmoq/transport';
import { isCmafHeader, isSyncSampleFlags, LocmafTrackDecoder, parseLocmafTrackContext, readCmafObjectSamples } from '@openmoq/locmaf';
import type { CmafChunkSamples, LocmafTrackContext } from '@openmoq/locmaf';
import type { MoqtPlayerConfig } from './config.js';
import type { CmafAssemblerLike } from './interfaces.js';
import type { FractionUs } from './presentation-placement.js';

export interface PreparedMseOutput {
  readonly role: 'video' | 'audio';
  readonly trackName: string;
  readonly sourceKey: string;
  readonly packaging: 'cmaf' | 'locmaf';
  readonly init: Uint8Array;
  readonly anchor: { readonly sourceTimeUs: bigint; readonly rebasedTimeUs: FractionUs };
  readonly objects: readonly MoqtObject[];
  readonly startLocation?: { readonly groupId: bigint; readonly objectId: bigint };
}

interface OutputState {
  readonly output: PreparedMseOutput;
  readonly context: LocmafTrackContext;
  readonly decoder: LocmafTrackDecoder | null;
  readonly pending: Map<bigint, Uint8Array>;
  emissions: number;
}

function validateSamples(reads: readonly CmafChunkSamples[]): void {
  if (!reads.length || reads.some(({ effective }) => !effective.durations.length
      || effective.durations.some(duration => duration <= 0) || effective.sizes.some(size => size <= 0))) {
    throw new Error('MSE preflight has no complete coded samples');
  }
}

/**
 * Prove synchronous assembly on one owned, isolated factory instance. Inputs
 * are already selected/ordered by the engine; no live assembler, source, native
 * queue or diagnostic input token is touched. Success is assembly evidence only.
 */
export function preflightMseOutputs(
  create: NonNullable<MoqtPlayerConfig['createCmafAssembler']>,
  live: CmafAssemblerLike,
  outputs: readonly PreparedMseOutput[],
  assertCurrent: () => void,
): void {
  let owned: CmafAssemblerLike | null = null, closed = false;
  let active: { state: OutputState; group: bigint; complete: boolean } | null = null;
  let callbackFailed = false;
  let callbackFailure: unknown;
  const guard = () => {
    assertCurrent();
    if (callbackFailed) throw callbackFailure;
  };
  // Observe custom thenables before any cancellation check can escape. The
  // synchronous contract still refuses them, including asynchronous destroy.
  const observeThenable = (value: unknown): boolean => {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
    const then: unknown = Reflect.get(value, 'then');
    if (typeof then !== 'function') return false;
    const observed = new Promise<unknown>((resolve, reject) => {
      try {
        const chain: unknown = Reflect.apply(then, value, [resolve, reject]);
        // A custom thenable may return a separate rejected chain without
        // settling the supplied handlers. Own that rejection as well.
        if (chain !== value) void Promise.resolve(chain).catch(() => {});
      }
      catch (error) { reject(error); }
      finally { try { assertCurrent(); } catch (error) { reject(error); } }
    });
    void observed.catch(() => {});
    return true;
  };
  const call = <T>(work: () => T): T => {
    try {
      const result = work();
      if (observeThenable(result)) throw new Error('MSE preflight requires synchronous assembler methods');
      return result;
    } finally { guard(); }
  };
  const onSegment: Parameters<NonNullable<MoqtPlayerConfig['createCmafAssembler']>>[0]['onSegment'] =
    (role, bytes, name, group, _inputs, key) => {
      if (closed) {
        // Cached callbacks after disposal own no emission. A cancellation from
        // a late callback cannot become an uncaught asynchronous exception.
        try { assertCurrent(); } catch { /* No operation remains to cancel. */ }
        return;
      }
      try {
        guard();
        if (!active || !active.complete || active.state.output.role !== role || active.state.output.trackName !== name
            || active.state.output.sourceKey !== key || active.group !== group) {
          throw new Error('MSE preflight emission does not belong to the current media push');
        }
        const reads = readCmafObjectSamples(bytes, active.state.context);
        if (reads === null) throw new Error('MSE preflight emitted an incomplete segment');
        validateSamples(reads);
        if (role === 'video' && active.state.emissions === 0 && !isSyncSampleFlags(reads[0]!.effective.flags[0] ?? 0x10000)) {
          throw new Error('MSE preflight video does not start with a random access sample');
        }
        active.state.emissions++;
      } catch (error) {
        callbackFailed = true; callbackFailure = error; throw error;
      } finally {
        try { assertCurrent(); }
        catch (error) { callbackFailed = true; callbackFailure = error; throw error; }
      }
    };

  try {
    guard();
    let candidate: CmafAssemblerLike;
    try { candidate = create({ onSegment }); }
    catch (error) { guard(); throw error; }
    // Strict identity is checked before any candidate capability getter,
    // mutation, or cleanup. Only a distinct returned handle becomes owned.
    if (candidate !== live) owned = candidate;
    guard();
    if (candidate === live) throw new Error('MSE preflight factory returned the live assembler');
    const identity = call(() => candidate.supportsTrackIdentity);
    const initialize = call(() => candidate.setInitSegment), select = call(() => candidate.selectTrack);
    const place = call(() => candidate.setPresentationPlacement), capture = call(() => candidate.capturePresentationPlacement);
    if (identity !== true || typeof initialize !== 'function' || typeof select !== 'function'
        || typeof place !== 'function' || typeof capture !== 'function') {
      throw new Error('MSE preflight assembler lacks identity or presentation placement capabilities');
    }
    const states: OutputState[] = [];
    const roles = new Set<PreparedMseOutput['role']>();
    for (const output of outputs) {
      if (roles.has(output.role)) throw new Error('MSE preflight requires one output per media role');
      roles.add(output.role);
      const init = output.init.slice(), context = parseLocmafTrackContext(init);
      const state: OutputState = { output, context, decoder: output.packaging === 'locmaf' ? new LocmafTrackDecoder(init) : null,
        pending: new Map(), emissions: 0 };
      states.push(state);
      call(() => initialize.call(candidate, output.role, init));
      call(() => select.call(candidate, output.role, output.trackName, output.sourceKey));
      call(() => place.call(candidate, output.role, { sourceTimeUs: output.anchor.sourceTimeUs,
        rebasedTimeUs: { ...output.anchor.rebasedTimeUs } }));
    }
    for (const state of states) {
      const { output } = state;
      for (const object of output.objects) {
        if (object.kind !== 'data') continue;
        const group = BigInt(object.groupId);
        let bytes: Uint8Array = object.payload.slice();
        if (state.decoder) {
          const decoded = state.decoder.push(group, BigInt(object.objectId), bytes);
          if (decoded.kind === 'rejected') throw decoded.error;
          bytes = decoded.bytes;
        }
        const start = output.startLocation;
        if (start && (group < start.groupId || group === start.groupId && object.objectId < start.objectId)) continue;
        let complete = false;
        if (bytes.length && !isCmafHeader(bytes)) {
          let combined = bytes;
          const pending = state.pending.get(group);
          if (pending) {
            // Keep intervening boxes and original offsets, just as playback
            // does. The format reader validates the complete pair below.
            combined = new Uint8Array(pending.length + bytes.length); combined.set(pending); combined.set(bytes, pending.length);
            state.pending.delete(group);
          }
          const reads = readCmafObjectSamples(combined, state.context);
          if (reads === null) state.pending.set(group, combined);
          else { validateSamples(reads); complete = true; }
        }
        const before = state.emissions;
        active = { state, group, complete };
        try { call(() => candidate.push(output.role, output.trackName, group, bytes, undefined, undefined, output.sourceKey)); }
        finally { active = null; }
        if (complete && state.emissions === before) throw new Error('MSE preflight did not emit complete media');
      }
      if (state.pending.size || !state.emissions) throw new Error('MSE preflight is missing complete paired media');
      const placement = call(() => capture.call(candidate, output.role));
      if (placement === null || placement === undefined) throw new Error('MSE preflight has no delivered presentation placement');
    }
    guard();
  } finally {
    closed = true; active = null;
    if (owned !== null) {
      try {
        const result: unknown = owned.destroy();
        if (observeThenable(result)) throw new Error('MSE preflight does not support asynchronous cleanup');
      } finally { assertCurrent(); }
    }
  }
}
