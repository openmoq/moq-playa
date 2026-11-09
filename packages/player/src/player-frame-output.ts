import type { ClockSource } from '@openmoq/playback';
import type { FrameOutput, FrameOutputAdapters, MoqtPlayerConfig } from './config.js';
import { createPipelines, type PipelineCallbacks, type PipelineSet, type TrackInfo } from './player-pipeline.js';
import { usesMsePath } from './packaging.js';
import { FrameAudioOutput } from './frame-audio-output.js';

const roles = ['videoDecoder', 'renderer', 'audioDecoder', 'audioOutput'] as const;
const properties = [...roles, 'scope', 'onAdopt', 'onRetire'] as const;
type Destroyable = { destroy(): void };

function isResourceList(value: Readonly<FrameOutputAdapters> | readonly object[]): value is readonly object[] {
  return Array.isArray(value);
}

/** Refuse async boundaries synchronously and own their otherwise unhandled rejection. */
function requireSynchronous(value: unknown, message: string): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')
      && typeof (value as { then?: unknown }).then === 'function') {
    // The caller receives the synchronous contract error even for a fulfilled
    // Promise. This handler owns invalid async results, not accepted work.
    void Promise.resolve(value).catch(() => {});
    throw new Error(message);
  }
}

export interface PreparedFramePipelines {
  readonly pipelines: PipelineSet;
  readonly output: Readonly<FrameOutputAdapters>;
  /** All known raw and adapted identities; only the dispatcher destroys adapters. */
  readonly resources: readonly object[];
  readonly audioPreparation?: FrameAudioOutput;
  /** Called only after the engine has transferred routing/output authority. */
  adopt(playing: boolean): void;
  /** The engine detaches routes first. This is the sole adapter destroy owner. */
  retire(): void;
}

/**
 * Acquire a complete fresh graph before constructing a dispatcher, whose
 * constructor replaces decoder and renderer callbacks. A refused candidate
 * must never reset, destroy or rewire the current output.
 */
export function createFramePipelines(
  config: MoqtPlayerConfig,
  clock: ClockSource,
  info: TrackInfo,
  callbacks: PipelineCallbacks,
  borrowed: Readonly<FrameOutputAdapters> | readonly object[],
  handshakeRttMs?: number,
  audioOptions?: { readonly retainDeferred?: boolean; readonly onPrepared?: () => void },
  scope?: 'video',
): PreparedFramePipelines {
  const factory = config.createFrameOutput;
  if (!factory) throw new Error('Frame-mode seek requires createFrameOutput');
  const video = info.video !== undefined, audio = info.audio !== undefined;
  if ((!video && !audio) || usesMsePath(info.video?.packaging, config.locmafDecoding)
      || usesMsePath(info.audio?.packaging, config.locmafDecoding)) {
    throw new Error('Frame output requires frame-decoded tracks');
  }
  if (scope !== undefined && (scope !== 'video' || !video || audio)) {
    throw new Error('Video-only frame output scope requires only video');
  }
  const held = new Set<unknown>((isResourceList(borrowed) ? borrowed : roles.map(role => borrowed[role]))
    .filter(value => value !== undefined));
  const fresh = new Set<Destroyable>();
  // A throwing factory still owns allocations it did not return.
  const result: unknown = factory(Object.freeze({ video, audio, clock, ...(scope ? { scope } : {}) }));
  const snapshot: Record<string, unknown> = Object.create(null);
  try {
    if (result === null || typeof result !== 'object') throw new Error('Frame output must be a plain record');
    const descriptors = Object.getOwnPropertyDescriptors(result);
    // Acquire every known data reference before validating any one property.
    for (const role of roles) {
      const descriptor = descriptors[role];
      if (descriptor && 'value' in descriptor) {
        const value: unknown = descriptor.value;
        snapshot[role] = value;
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && !held.has(value)) {
          fresh.add(value as Destroyable);
        }
      }
    }
    requireSynchronous(result, 'Frame output must be a plain record, not an asynchronous result');
    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Frame output must be a plain record');
    for (const property of properties) {
      const descriptor = descriptors[property];
      if (descriptor && !('value' in descriptor)) throw new Error(`Frame output ${property} must be a data property`);
      if (descriptor) snapshot[property] = descriptor.value;
    }
    if (snapshot['scope'] !== scope) throw new Error('Frame output scope must match the requested adoption scope');
    const seen = new Set<unknown>();
    for (const role of roles) {
      const value = snapshot[role];
      const required = role === 'videoDecoder' || role === 'renderer' ? video : audio;
      if (!required) {
        if (value !== undefined) throw new Error(`Frame output returned unrequested ${role}`);
        continue;
      }
      if (value === null || (typeof value !== 'object' && typeof value !== 'function')) throw new Error(`Frame output missing ${role}`);
      if (held.has(value)) throw new Error(`Frame output reused current ${role}`);
      if (seen.has(value)) throw new Error('Frame output reused one adapter across roles');
      seen.add(value);
      const adapter = value as Record<string, unknown>;
      const methods = role === 'videoDecoder' || role === 'audioDecoder'
        ? ['configure', 'decode', 'flush', 'reset', 'destroy']
        : role === 'renderer' ? ['enqueue', 'flush', 'destroy', 'observeFrames']
          : ['schedule', 'flush', 'destroy', 'observeSchedules', 'sampleSourcePosition'];
      for (const method of methods) {
        if (typeof adapter[method] !== 'function') throw new Error(`Frame output ${role} cannot ${method}`);
      }
      if (adapter.supportsOutputTiming !== true && !(role === 'audioOutput' && adapter.outputTimingDeferred === true)) {
        throw new Error(`Frame output ${role} cannot prove producing timing`);
      }
    }
    for (const name of ['onAdopt', 'onRetire'] as const) {
      if (snapshot[name] !== undefined && typeof snapshot[name] !== 'function') throw new Error(`Frame output ${name} must be a function`);
    }
    const factoryOutput = Object.freeze(snapshot) as Readonly<FrameOutput>;
    const audioPreparation = factoryOutput.audioOutput
      ? new FrameAudioOutput({ target: factoryOutput.audioOutput, maxChunks: 512, maxBytes: 8 * 1024 * 1024, ...audioOptions }) : undefined;
    if (audioPreparation) {
      fresh.delete(factoryOutput.audioOutput!);
      fresh.add(audioPreparation);
    }
    const output: Readonly<FrameOutput> = audioPreparation
      ? Object.freeze({ ...factoryOutput, audioOutput: audioPreparation }) : factoryOutput;
    const resources = Object.freeze([...new Set(roles.flatMap(role => {
      const original = factoryOutput[role], adapted = output[role];
      return [...(original ? [original] : []), ...(adapted ? [adapted] : [])];
    }))]);
    const pipelines = createPipelines(config, clock, info, callbacks, handshakeRttMs, output);
    // Construction succeeded: destruction belongs to the dispatcher from here.
    fresh.clear();
    let retired = false, adoptionBegan = false;
    return Object.freeze({
      pipelines,
      output,
      resources,
      ...(audioPreparation ? { audioPreparation } : {}),
      adopt(playing: boolean): void {
        if (retired) throw new Error('Frame output is retired');
        if (adoptionBegan) return;
        adoptionBegan = true;
        requireSynchronous(output.onAdopt?.(Object.freeze({ playing })), 'Frame output onAdopt must complete synchronously');
      },
      retire(): void {
        if (retired) return;
        retired = true;
        const errors: unknown[] = [];
        try { pipelines.commandDispatcher?.destroy(); } catch (error) { errors.push(error); }
        if (adoptionBegan) {
          try { requireSynchronous(output.onRetire?.(), 'Frame output onRetire must complete synchronously'); }
          catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Frame output retirement failed');
      },
    });
  } catch (error) {
    const errors: unknown[] = [error];
    for (const adapter of fresh) {
      try { if (typeof adapter.destroy === 'function') adapter.destroy(); } catch (cleanupError) { errors.push(cleanupError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Frame output preparation failed');
    throw error;
  }
}
