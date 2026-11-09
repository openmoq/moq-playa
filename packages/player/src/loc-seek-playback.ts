import { parseLocHeaders, resolveLocHeaders, toAudioChunkInit, toVideoChunkInit } from '@openmoq/loc';
import type { LocHeaders, LocTrackContext, SourceTimestamp } from '@openmoq/loc';
import type { MediaTimelineEntry } from '@openmoq/msf';
import type { AudioTimingSource, ClockSource, DecoderCommand, PlaybackEvent, PlaybackPipeline } from '@openmoq/playback';
import { LocmafFrameReader, type LocmafFrameHeader } from '@openmoq/locmaf';
import { locmafPlaybackSamples } from './locmaf-playback-samples.js';
import type { MoqtObject, PropertyWireProfile, TrackPropertyValue } from '@openmoq/transport';
import type { MoqtPlayerConfig, FrameOutputAdapters } from './config.js';
import type { MediaDiscardReason } from './media-diagnostic-types.js';
import type { InstalledDecoderConfiguration } from './prepared-decoder-configuration.js';
import { createFramePipelines, type PreparedFramePipelines } from './player-frame-output.js';
import { configurePipelines, handlePipelineCommand, type TrackInfo } from './player-pipeline.js';
import { LocSeekInput, locIndexedPositionMs, projectLocResumePoint, snapshotLocIndexedPlacement, snapshotLocResumePoint,
  type LocSeekPreparation, type LocSeekItem, type LocSeekSampleObject, type LocIndexedPlacement, type LocSeekResumePoint } from './loc-seek-input.js';
import { LocSeekVideoOutput } from './loc-seek-video-output.js';
import { constrainLocTimelineMapping, snapshotLocTimelineMapping, type LocTimelineMappingState } from './loc-timeline-mapping.js';
import { nativeTimeUs } from './presentation-placement.js';
import { SeekLiveQueue, type SeekLiveStreamLease } from './seek-live-queue.js';
import type { SeekGroupPageAcceptance, SeekInputReceiver, SeekLiveInput } from './mse-seek-playback.js';

type Role = 'video' | 'audio';
/** Private same-selection continuity evidence, captured before native output is flushed. */
export interface LocSeekResume {
  readonly reference: Role;
  readonly point: LocSeekResumePoint;
  readonly videoPlacement?: LocIndexedPlacement;
  readonly audioPlacement?: LocIndexedPlacement;
  readonly videoMapping?: LocTimelineMappingState;
  readonly audioMapping?: LocTimelineMappingState;
}
type DecoderSeed = Pick<InstalledDecoderConfiguration, 'requested' | 'configured' | 'format'>;
export type LocSeekTrack = ({ readonly role: 'video'; readonly info: NonNullable<TrackInfo['video']>; readonly seed: DecoderSeed }
  | { readonly role: 'audio'; readonly info: NonNullable<TrackInfo['audio']>; readonly seed: DecoderSeed })
  & { readonly frameInit?: Uint8Array };
interface Page {
  readonly identity: object;
  readonly queue: SeekLiveQueue;
  stream: SeekLiveStreamLease | null;
  receipt: SeekGroupPageAcceptance | null;
  context: LocTrackContext;
  input: object | undefined;
  pushing: boolean;
}
interface RoleState {
  readonly track: LocSeekTrack;
  input: LocSeekInput;
  group: bigint;
  groupClosed: boolean;
  prepared: boolean;
  readonly prefix: LocSeekItem[];
  readonly samplePrefix: LocSeekSampleObject[];
  frameReader: LocmafFrameReader | null;
  page: Page | null;
  live: { readonly owner: object; readonly context: LocTrackContext; closed: boolean } | null;
  anchor: SourceTimestamp | null;
  placement: LocIndexedPlacement | null;
  readonly resume: LocSeekResumePoint | undefined;
  mapping: LocTimelineMappingState | undefined;
  readonly indexedSamples: Map<string, SourceTimestamp>;
  selected: Pick<Extract<LocSeekPreparation, { kind: 'ready' }>, 'selected' | 'placement'> | null;
  seeded: boolean;
  configuration: InstalledDecoderConfiguration | null;
  configurationCall: object | null;
  releaseEnd: ((completeTrack?: boolean) => void) | null;
  inputEnding: boolean;
  endWork: Promise<void> | null;
}
interface Options {
  readonly config: MoqtPlayerConfig;
  /** Snapshotted from the connected session, independently of the tune-in hint. */
  readonly wireProfile: PropertyWireProfile;
  readonly clock: ClockSource;
  readonly borrowed: Readonly<FrameOutputAdapters> | readonly object[];
  readonly tracks: readonly LocSeekTrack[];
  readonly location: { readonly groupId: bigint; readonly objectId: bigint };
  readonly mediaPts: number;
  readonly targetMs: number;
  readonly requiredPositionMs?: number;
  readonly timestampRounding: 'floor' | 'nearest';
  readonly getTimelineEntries: () => readonly MediaTimelineEntry[] | null;
  readonly playing: boolean;
  readonly resume?: LocSeekResume;
  /** Called after graph acquisition, before any retained input is decoded. */
  readonly onGraphCreated: () => void;
  /** Cleanup retains its observation owner even after functional routing ends. */
  readonly onGraphRetiring: (graph: PreparedFramePipelines) => void;
  readonly onGraphRetired: (graph: PreparedFramePipelines) => void;
  readonly isCurrent: () => boolean;
  readonly adopt: (prepared: PreparedFramePipelines) => void;
  readonly onPosition: (positionMs: number, location: Options['location']) => void;
  readonly onFirstFrame: () => void;
  readonly onFrameRendered: (captureTimestampUs: bigint, actualRenderUs: number) => void;
  readonly onCommand: (command: DecoderCommand) => void;
  readonly onConfiguration: (role: Role, configuration: InstalledDecoderConfiguration) => void;
  readonly onEvent: (role: Role, event: PlaybackEvent) => void;
  readonly onDiscard: (input: object, reason: MediaDiscardReason) => void;
  readonly onPageDrained: (role: Role, identity: object) => void;
  readonly onPageError: (role: Role, identity: object, error: Error) => void;
  readonly onError: (error: Error) => void;
}
const abortError = () => Object.assign(new Error('LOC seek output retired'), { name: 'AbortError' });
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const sourceUs = (point: SourceTimestamp) => point.ticks * 1_000_000n / point.ticksPerSecond;
function trackContext(properties: ReadonlyMap<bigint, readonly TrackPropertyValue[]> | undefined): LocTrackContext {
  const headers = resolveLocHeaders([...properties ?? []].flatMap(([id, values]) => values.map(value => ({ id, value }))));
  return { ...(headers.timescale === undefined ? {} : { timescale: headers.timescale }),
    ...(headers.videoConfig === undefined ? {} : { videoConfig: headers.videoConfig }),
    ...(headers.audioConfig === undefined ? {} : { audioConfig: headers.audioConfig }) };
}
const ceil = (numerator: bigint, denominator: bigint) => numerator <= 0n ? numerator / denominator : (numerator + denominator - 1n) / denominator;
// Quantize the complete source point once. Truncating the source anchor first
// can lower a requested bound when later native chunks have another fraction.
const shiftedSourceUs = (anchor: SourceTimestamp, numerator: bigint, denominator: bigint) =>
  ceil(anchor.ticks * 1_000_000n * denominator + numerator * anchor.ticksPerSecond, anchor.ticksPerSecond * denominator);
const frameReadLimits = Object.freeze({ maxGroups: 8, maxSamples: 512, maxEntries: 65536, maxBytes: 8 * 1024 * 1024 });

/** Frame preparation/output only; the shared role retrieval owns every request. */
export class LocSeekPlayback {
  private graph: PreparedFramePipelines | null = null;
  private output: LocSeekVideoOutput | null = null;
  private readonly roles = new Map<Role, RoleState>();
  private readonly audioEpoch = {};
  private audioBoundary: bigint | null = null;
  private audioOffset = 0n;
  private stopped = false;
  private adopted = false;
  private positioned = false;
  private playing: boolean;
  private frozen = false;
  private frozenPositionMs: number | null = null;
  private frozenResume: LocSeekResume | null = null;
  private lastAudioPoint: LocSeekResumePoint | null = null;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pressureTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wakeups = new Set<() => void>();
  private readonly options: Omit<Options, 'borrowed'>;
  private borrowed: Options['borrowed'] | null;

  constructor(options: Options) {
    const { borrowed, ...retained } = options;
    this.options = retained;
    this.borrowed = borrowed;
    this.playing = options.playing;
    for (const track of options.tracks) {
      if (this.roles.has(track.role)) throw new Error('Duplicate LOC seek output role');
      const placement = options.resume?.[track.role === 'video' ? 'videoPlacement' : 'audioPlacement'];
      if (options.resume && !placement) throw new Error(`LOC resume lacks ${track.role} placement`);
      const resume = placement && options.resume ? projectLocResumePoint(options.resume.point, placement) : undefined;
      this.roles.set(track.role, { track, input: new LocSeekInput({ role: track.role,
        ...(track.info.codec ? { codec: track.info.codec } : {}), location: options.location, mediaPts: options.mediaPts,
        targetMs: options.targetMs, timestampRounding: options.timestampRounding, placementMode: 'indexed-relative',
        ...(resume ? { resume } : {}),
        maxObjects: 512, maxBytes: 8 * 1024 * 1024, onDiscard: options.onDiscard }),
      group: options.location.groupId, groupClosed: false, prepared: false, prefix: [], samplePrefix: [],
      frameReader: track.info.packaging === 'locmaf' ? new LocmafFrameReader(track.frameInit, frameReadLimits) : null,
      page: null, live: null,
      anchor: null, placement: null, resume,
      mapping: options.resume?.[track.role === 'video' ? 'videoMapping' : 'audioMapping'] === undefined ? undefined
        : snapshotLocTimelineMapping(options.resume[track.role === 'video' ? 'videoMapping' : 'audioMapping']!),
      indexedSamples: new Map(), selected: null, seeded: false, configuration: null, configurationCall: null, releaseEnd: null, inputEnding: false, endWork: null });
      const state = this.roles.get(track.role)!;
      const header = state.frameReader?.snapshotInitialization();
      if (header) this.validateFrameHeader(state, header);
    }
    if (!this.roles.size) throw new Error('LOC seek has no selected output');
  }

  get committed(): boolean { return this.adopted; }
  get suspended(): boolean { return this.frozen; }
  /** Only an owned graph may participate in an installed diagnostic lifetime. */
  get diagnosticGraph(): PreparedFramePipelines | null { return this.current() ? this.graph : null; }
  /** A frozen epoch is never queried; a paused preview may supply its actual draw. */
  get resumePoint(): LocSeekResume | null {
    if (!this.current()) return null;
    return this.frozen ? this.frozenResume : this.snapshotResumePoint();
  }
  installedConfiguration(role: Role): InstalledDecoderConfiguration | null { return this.roles.get(role)?.configuration ?? null; }
  isEnding(role: Role): boolean { return this.current() && this.roles.get(role)?.inputEnding === true; }
  /** Check raw updates before location deduplication can hide a conflicting anchor. */
  observeTimeline(entries: readonly MediaTimelineEntry[]): void {
    if (!this.current()) return;
    try {
      for (const state of this.roles.values()) for (const entry of entries) {
        const sample = state.indexedSamples.get(JSON.stringify(entry.location));
        if (sample) state.mapping = constrainLocTimelineMapping(state.mapping, sample, entry.mediaPts, this.options.timestampRounding);
      }
      // Keep the observed pause point, but carry any newly narrowed evidence
      // into its next preparation without reading a flushed native clock.
      if (this.frozen && this.frozenResume) this.frozenResume = Object.freeze({ ...this.frozenResume, ...this.snapshotMappings() });
    } catch (error) {
      // New timeline evidence still governs a paused mapping. A late native
      // callback, in contrast, cannot fail an already frozen output epoch.
      this.fail(error, 'retire');
    }
  }
  preparingGroup(role: Role): bigint | null {
    const state = this.roles.get(role);
    return state && !state.prepared && !state.groupClosed ? state.group : null;
  }
  readPositionMs(): number | null {
    if (!this.current()) return null;
    if (this.frozen) return this.frozenPositionMs;
    const sample = this.graph?.audioPreparation?.sampleSourcePosition(this.audioEpoch), state = this.roles.get('audio');
    if (!this.current() || this.frozen) return this.frozen ? this.frozenPositionMs : null;
    if (this.adopted && sample?.epoch === this.audioEpoch && state?.placement) {
      const offset = nativeTimeUs(sample.sourceOffsetUs);
      if (offset && sample.sourceOffsetUs >= 0 && typeof sample.sourceTimestampUs === 'bigint') {
        const scale = offset.denominator * 1_000_000n;
        const point = snapshotLocResumePoint({ placement: state.placement, source: {
          ticks: sample.sourceTimestampUs * scale + offset.numerator, ticksPerSecond: scale * 1_000_000n,
          domain: state.placement.sourceAnchor.domain } });
        const time = locIndexedPositionMs(point.placement, point.source);
        if (this.current() && !this.frozen && time !== null) { this.lastAudioPoint = point; return time; }
      }
    }
    // Once audio owns the running clock, a temporary lack of an occupied
    // native buffer holds the last observation instead of reverting to video.
    return this.lastAudioPoint || this.options.resume?.reference === 'audio' ? null : this.output?.readPositionMs() ?? null;
  }

  start(): void {
    if (!this.current() || this.graph) return;
    try {
      this.deadline = performance.now() + this.options.config.connectionTimeoutMs!;
      const info = this.trackInfo();
      let graph: PreparedFramePipelines;
      try {
        graph = createFramePipelines(this.options.config, this.options.clock, info, {
          onFirstFrame: () => { if (this.adopted && this.current() && !this.frozen) this.options.onFirstFrame(); },
          onFrameRendered: (capture, actual) => { if (this.adopted && this.current() && !this.frozen) this.options.onFrameRendered(capture, actual); },
          onStall() {},
          onDecodeError: (_role, error) => this.fail(error),
          onFeedback: feedback => { this.pipeline(feedback.mediaType)?.handleFeedback(feedback); this.wake(); },
          onCommand: command => this.command(command),
          onEvent: (role, event) => { if (this.adopted && this.current() && !this.frozen) this.options.onEvent(role, event); },
        }, this.borrowed ?? [], undefined, { retainDeferred: true, onPrepared: () => { this.maybeAdopt(); this.wake(); } });
      } finally { this.borrowed = null; }
      this.graph = graph;
      if (!this.current()) { graph.retire(); return; }
      for (const state of this.roles.values()) {
        const pipeline = this.pipeline(state.track.role);
        if (!pipeline) throw new Error(`LOC seek has no ${state.track.role} pipeline`);
      }
      this.options.onGraphCreated();
      if (!this.current()) { graph.retire(); return; }
      this.assertPreparationTime();
      this.timer = setTimeout(() => this.fail(new Error('LOC seek media preparation timed out')), Math.max(0, this.deadline! - performance.now()));
    } catch (error) { this.fail(error); }
  }

  beginPage(role: Role, identity: object): SeekInputReceiver {
    this.assertCurrent();
    const state = this.roles.get(role)!;
    if (state.page) throw new Error('Previous LOC seek page has not drained');
    let page!: Page;
    const queue = new SeekLiveQueue({ maxObjects: 512, maxBytes: 8 * 1024 * 1024,
      isCurrent: () => this.current() && state.page === page,
      capture: () => page.input,
      onDiscard: input => this.options.onDiscard(input, 'decoder reset'),
      consumePrefix: (object, input, current) => this.receive(state, page.context, object, input, current),
      consumeLive: async () => { throw new Error('Unexpected LOC page live lane'); },
      onPrefixDrained: async () => {
        if (!this.current() || state.page !== page) return;
        const receipt = page.receipt!;
        if (!state.prepared && (receipt.endOfTrack || receipt.through.groupId > state.group
            || receipt.through.groupId === state.group && receipt.through.kind === 'after-group')) await this.closeGroup(state);
        if (!state.prepared && receipt.endOfTrack) throw new Error('LOC history ended before the requested target');
        if (!this.current() || state.page !== page) return;
        state.page = null;
        this.options.onPageDrained(role, identity);
      },
      onTrackEnded() {}, onError: error => {
        if (this.current() && state.page === page) this.options.onPageError(role, identity, error);
      } });
    page = { identity, queue, stream: null, receipt: null, context: {}, input: undefined, pushing: false };
    state.page = page;
    page.stream = queue.openPrefix();
    return {
      onObject: (object, input) => {
        if (!this.current() || state.page !== page) { if (input) this.options.onDiscard(input, 'decoder reset'); return Promise.resolve(); }
        if (page.pushing) { if (input) this.options.onDiscard(input, 'invalid media'); return Promise.reject(new Error('Reentrant LOC page admission')); }
        page.pushing = true; page.input = input;
        try {
          const work = page.stream!.push(object);
          // Data and FIN may precede their own FETCH_OK. Retain them boundedly;
          // only that response supplies the defaults used to parse these bytes.
          return page.receipt === null ? Promise.resolve() : work;
        } finally { page.input = undefined; page.pushing = false; }
      },
      onClosed: terminal => page.stream!.close(terminal),
    };
  }

  acceptPage(role: Role, identity: object, _endOfTrack: boolean, receipt?: SeekGroupPageAcceptance): void {
    const page = this.roles.get(role)?.page;
    if (!this.current() || !page || page.identity !== identity || page.receipt) return;
    try {
      if (!receipt || receipt.groupOrder !== 'ascending' || receipt.rangeFilters !== false) throw new Error('LOC history lacks ordered unfiltered request provenance');
      page.context = trackContext(receipt.trackProperties);
      page.receipt = receipt; page.queue.acceptPrefix();
    } catch (error) { this.fail(error); }
  }

  beginLive(role: Role, owner: object, properties: ReadonlyMap<bigint, readonly TrackPropertyValue[]>): SeekLiveInput {
    this.assertCurrent();
    const state = this.roles.get(role);
    if (!state?.prepared || state.page || state.live || state.inputEnding) throw new Error('LOC live input has no prepared role');
    const live = { owner, context: trackContext(properties), closed: false };
    state.live = live;
    const current = () => this.current() && !this.frozen && state.live === live && !live.closed;
    return {
      onObject: async (object, input, admitted = () => true) => {
        const owns = () => current() && admitted();
        if (!owns()) { if (input) this.options.onDiscard(input, 'route retired'); return; }
        try { await this.deliver(state, object, live.context, input, owns, false); }
        catch (error) { if (current()) this.fail(error); throw error; }
      },
      endTrack: () => current() ? this.finishRoleInput(state) : Promise.resolve(),
      cancel: () => { live.closed = true; if (state.live === live) state.live = null; this.wake(); },
    };
  }

  tick(): void {
    if (!this.current() || this.frozen) return;
    try {
      if (this.pipeline('video')?.throttled || this.pipeline('audio')?.throttled) this.graph?.pipelines.commandDispatcher?.resampleQueuePressure();
      if (!this.current() || this.frozen) return;
      this.maybeAdopt();
      if (this.adopted) {
        for (const role of this.roles.keys()) this.pipeline(role)?.tick();
        // Draining input is progress even with a synchronous decoder that
        // has no separate queue-depth notification.
        this.wake();
        this.activateAudio();
        if ((!this.output || this.options.resume?.reference === 'audio') && !this.positioned) {
          const time = this.readPositionMs();
          if (time !== null) this.reportPosition(time, this.options.location);
        }
      }
    } catch (error) { this.fail(error); }
  }
  setPlaying(playing: boolean, positionMs?: number | null): void {
    if (!this.current()) return;
    this.playing = playing;
    if (!this.adopted) { this.output?.setMode(playing ? 'playing' : 'preview'); return; }
    if (playing || this.frozen) return;
    const observed = this.positioned || this.options.resume ? positionMs ?? this.readPositionMs() : null;
    this.frozenPositionMs = observed !== null && Number.isFinite(observed) && observed >= 0 ? observed : null;
    this.frozenResume = this.snapshotResumePoint();
    // Flushed native state cannot be revived. Resume uses a new historical
    // preparation; this epoch retains only its last observed position/image.
    this.frozen = true;
    this.wake();
    const failures: unknown[] = [];
    for (const state of this.roles.values()) {
      const page = state.page; state.page = null;
      try { page?.queue.cancel(); } catch (error) { failures.push(error); }
      try { this.pipeline(state.track.role)?.reset(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'LOC pause cleanup failed');
  }
  endInput(role: Role): void {
    const state = this.roles.get(role);
    if (!this.current() || this.frozen || !state) return;
    void this.finishRoleInput(state).catch(() => {});
  }

  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.borrowed = null;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const failures: unknown[] = [];
    const release = (run: () => void) => { try { run(); } catch (error) { failures.push(error); } };
    const graph = this.graph;
    if (graph) release(() => this.options.onGraphRetiring(graph));
    this.wake();
    for (const state of this.roles.values()) {
      if (state.live) state.live.closed = true; state.live = null;
      state.indexedSamples.clear();
      release(() => state.page?.queue.cancel()); state.page = null;
      const discarded = new Set(state.prefix.splice(0).flatMap(item => item.input ? [item.input] : []));
      for (const carrier of state.samplePrefix.splice(0)) if (carrier.input) discarded.add(carrier.input);
      release(() => state.frameReader?.retire()); state.frameReader = null;
      release(() => state.input.cancel());
      for (const input of discarded) release(() => this.options.onDiscard(input, 'decoder reset'));
      release(() => this.pipeline(state.track.role)?.reset()); state.releaseEnd = null;
    }
    release(() => this.output?.stop()); release(() => this.graph?.retire());
    if (graph) release(() => this.options.onGraphRetired(graph));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'LOC seek cleanup failed');
  }

  private async receive(state: RoleState, context: LocTrackContext, object: MoqtObject, input: object | undefined, current: () => boolean): Promise<void> {
    if (!current() || this.frozen) { if (input) this.options.onDiscard(input, 'decoder reset'); return; }
    if (state.prepared) { await this.deliver(state, object, context, input, current); return; }
    if (object.groupId > state.group) {
      await this.closeGroup(state);
      if (!current()) { if (input) this.options.onDiscard(input, 'decoder reset'); return; }
      if (state.prepared) { await this.deliver(state, object, context, input, current); return; }
      state.input = state.input.continueAt(object.groupId); state.group = object.groupId; state.groupClosed = false;
    }
    if (object.groupId < state.group) throw new Error('LOC history regressed in Group order');
    if (object.kind === 'gap') {
      if (input) this.options.onDiscard(input, 'orphaned media');
      if (object.status === 3n || object.status === 4n) await this.closeGroup(state);
      else throw new Error('LOC history has a missing dependency');
      return;
    }
    if (state.frameReader) {
      let samples;
      try {
        samples = this.frameSamples(state, object);
        const source = samples[0]?.chunk.sourceTimestamp;
        if (source) this.observeIndexedSample(state, object, source);
      } catch (error) { if (input) this.options.onDiscard(input, 'invalid media'); throw error; }
      state.input.pushSamples(object, samples, input);
      return;
    }
    const headers = parseLocHeaders(object.properties ?? object.extensions,
      { wireProfile: this.options.wireProfile, track: context });
    try { this.observeIndexedObject(state, object, headers); }
    catch (error) { if (input) this.options.onDiscard(input, 'invalid media'); throw error; }
    state.input.push(object, headers, input);
  }

  private async closeGroup(state: RoleState): Promise<void> {
    if (state.prepared || state.groupClosed) return;
    const role = state.track.role;
    if (role === 'audio') {
      // Video selection determines the common presentation boundary, not which
      // encoded audio chunk happens to start after the requested position.
      while (this.roles.has('video') && !this.roles.get('video')!.selected && this.current() && !this.frozen) await this.wait();
    }
    if (this.frozen) return;
    this.assertCurrent();
    const ready = role === 'video' ? state.input.finishGroup(state.group) : state.input.finishAudioGroup(state.group);
    state.groupClosed = true;
    if (ready.kind === 'need-more') return;
    state.anchor = ready.anchor;
    state.placement = ready.placement ?? null;
    if (ready.sampleObjects) state.samplePrefix.push(...ready.sampleObjects);
    else state.prefix.push(...ready.items);
    const graph = this.graph!, pipeline = this.pipeline(role)!;
    if (ready.kind === 'ready') {
      const selected = ready.selected;
      if (this.options.requiredPositionMs !== undefined && (!ready.placement
          || locIndexedPositionMs(ready.placement, selected.sourceTimestamp) !== this.options.requiredPositionMs)) {
        throw new Error('Target has no picture at the held nominal content position');
      }
      state.selected = { selected, ...(ready.placement ? { placement: ready.placement } : {}) };
      this.output = new LocSeekVideoOutput({ dispatcher: graph.pipelines.commandDispatcher!, renderer: graph.output.renderer!,
        sync: graph.pipelines.syncController, selected: ready.selected.sourceTimestamp,
        ...(ready.placement ? { placement: ready.placement } : {}), mode: this.playing ? 'playing' : 'preview',
        reference: this.options.resume?.reference === 'audio' ? 'external' : 'video',
        maxQueuedFrames: 8, isCurrent: () => this.current() && !this.frozen, onPrepared: () => { this.maybeAdopt(); this.wake(); },
        onPresented: time => {
          if (this.options.resume?.reference !== 'audio') this.reportPosition(time, selected.location);
          this.activateAudio();
        },
        onProgress: () => this.wake(), onError: error => this.fail(error) });
      this.output.start(); this.wake();
    }
    state.prepared = true;
    pipeline.reset(ready.items[0]?.object.groupId ?? state.group);
    state.releaseEnd = pipeline.holdTrackEnd();
    if (role === 'video') pipeline.setVideoTimingSource(this.output!.timingSource);
    else pipeline.setAudioTimingSource(this.audioTimingSource(state));
    const initData = btoa(String.fromCharCode(...state.track.seed.requested));
    const info = state.track.role === 'video' ? { video: { ...state.track.info, initData }, audio: undefined }
      : { video: undefined, audio: { ...state.track.info, initData } };
    configurePipelines(graph.pipelines, info);
    while (state.samplePrefix.length) {
      while (pipeline.throttled && this.current() && !this.frozen) { this.maybeAdopt(); await this.waitForQueueProgress(pipeline); }
      if (this.frozen) return;
      this.assertCurrent();
      const carrier = state.samplePrefix.shift()!;
      pipeline.pushSampleObject(carrier.object, carrier.samples, carrier.input, { backfill: true });
      pipeline.tick(); this.maybeAdopt();
    }
    while (state.prefix.length) {
      while (pipeline.throttled && this.current() && !this.frozen) { this.maybeAdopt(); await this.waitForQueueProgress(pipeline); }
      if (this.frozen) return;
      this.assertCurrent();
      const item = state.prefix.shift()!;
      pipeline.pushObject(item.object, item.headers, item.input, { backfill: true }); pipeline.tick(); this.maybeAdopt();
    }
    if (this.frozen) return;
    pipeline.endGroup(state.group);
    await this.drainSampleInput(pipeline);
    if (this.frozen) return;
    await this.decoder(role)!.flush(); this.assertCurrent(); this.maybeAdopt();
  }

  private audioTimingSource(state: RoleState): AudioTimingSource {
    const anchor = sourceUs(state.anchor!), video = this.roles.get('video');
    let numerator: bigint, denominator: bigint;
    if (state.resume) {
      this.audioBoundary = ceil(state.resume.source.ticks * 1_000_000n, state.resume.source.ticksPerSecond);
      if (video?.placement && state.placement) {
        this.audioOffset = sourceUs(video.placement.sourceAnchor) - sourceUs(state.placement.sourceAnchor)
          + BigInt(state.placement.mediaPts - video.placement.mediaPts) * 1000n;
      }
    } else if (video?.anchor && video.selected) {
      const chosen = video.selected.selected.sourceTimestamp;
      numerator = (chosen.ticks * video.anchor.ticksPerSecond - video.anchor.ticks * chosen.ticksPerSecond) * 1_000_000n;
      denominator = chosen.ticksPerSecond * video.anchor.ticksPerSecond;
      this.audioOffset = sourceUs(video.anchor) - anchor;
    } else {
      const exact = nativeTimeUs(this.options.targetMs)!;
      denominator = exact.denominator * 1000n;
      numerator = exact.numerator - BigInt(this.options.mediaPts) * 1_000_000n * exact.denominator
        + (this.options.timestampRounding === 'nearest' ? 500n * denominator : 0n);
    }
    if (!state.resume) this.audioBoundary = shiftedSourceUs(state.anchor!, numerator!, denominator!);
    const schedule = (raw: bigint, offset: number) => {
      if (!this.current() || this.frozen) return null;
      // Inactive retention is not scheduling evidence. The same context is
      // queried again by the actual output only after reference establishment.
      if (!this.adopted || !this.graph!.pipelines.syncController.hasReference) return this.options.clock.now();
      const value = this.graph!.pipelines.syncController.computeAudioRenderTime(raw + this.audioOffset);
      return value ? value.renderTimeUs + offset : null;
    };
    return Object.freeze({
      captureOutputTiming: (raw: bigint) => this.current() && !this.frozen ? Object.freeze({ epoch: this.audioEpoch, sourceTimestampUs: raw,
        presentFromSourceUs: this.audioBoundary!, recomputeRenderTimeUs: (offset: number) => schedule(raw, offset) }) : null,
      computeAudioRenderTime: (raw: bigint) => { const renderTimeUs = schedule(raw, 0); return renderTimeUs === null ? null : { renderTimeUs, offsetUs: 0, shouldDrop: false }; },
    });
  }

  private async deliver(state: RoleState, object: MoqtObject, context: LocTrackContext, input?: object,
    admitted: () => boolean = () => true, ordered = true): Promise<void> {
    const pipeline = this.pipeline(state.track.role)!;
    while (pipeline.throttled && this.current() && !this.frozen && admitted()) await this.waitForQueueProgress(pipeline);
    if (this.frozen || !admitted()) { if (input) this.options.onDiscard(input, 'route retired'); return; }
    this.assertCurrent();
    if (object.groupId > state.group) { if (ordered) pipeline.endGroup(state.group); state.group = object.groupId; }
    else if (ordered && object.groupId < state.group) throw new Error('LOC history regressed in Group order');
    if (object.kind === 'data' && state.frameReader) {
      let samples;
      try {
        samples = this.frameSamples(state, object);
        const source = samples[0]?.chunk.sourceTimestamp;
        if (source) this.observeIndexedSample(state, object, source);
      } catch (error) { if (input) this.options.onDiscard(input, 'invalid media'); throw error; }
      if (!admitted() || !this.current() || this.frozen) { if (input) this.options.onDiscard(input, 'route retired'); return; }
      pipeline.pushSampleObject(object, samples, input, ordered ? { backfill: true } : undefined);
      pipeline.tick(); this.maybeAdopt();
      return;
    }
    const headers = object.kind === 'data' ? parseLocHeaders(object.properties ?? object.extensions,
      { wireProfile: this.options.wireProfile, track: context }) : undefined;
    if (object.kind === 'data') {
      try { this.observeIndexedObject(state, object, headers!); }
      catch (error) { if (input) this.options.onDiscard(input, 'invalid media'); throw error; }
    }
    pipeline.pushObject(object, headers, input, ordered ? { backfill: true } : undefined); pipeline.tick(); this.maybeAdopt();
  }

  private observeIndexedObject(state: RoleState, object: Extract<MoqtObject, { kind: 'data' }>, headers: LocHeaders): void {
    this.observeIndexedSample(state, object, undefined, headers);
  }

  private observeIndexedSample(state: RoleState, object: Extract<MoqtObject, { kind: 'data' }>, source: SourceTimestamp | undefined,
    headers?: LocHeaders): void {
    const entries = this.options.getTimelineEntries();
    this.assertCurrent();
    if (!entries) return;
    let sample: SourceTimestamp | undefined, key: string | undefined;
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.location[0]) || !Number.isSafeInteger(entry.location[1])
          || BigInt(entry.location[0]) !== object.groupId || BigInt(entry.location[1]) !== object.objectId) continue;
      if (source === undefined && headers !== undefined) source = (state.track.role === 'video'
        ? toVideoChunkInit(object.payload, headers) : toAudioChunkInit(object.payload, headers)).sourceTimestamp;
      if (!source) throw new Error('LOC indexed Object has no source timestamp for its unit-rate mapping');
      sample ??= source;
      state.mapping = constrainLocTimelineMapping(state.mapping, sample, entry.mediaPts, this.options.timestampRounding);
      key ??= JSON.stringify(entry.location);
    }
    if (key === undefined || sample === undefined) return;
    state.indexedSamples.delete(key); state.indexedSamples.set(key, sample);
    // Retain only bounded recent witnesses. The interval keeps all constraints;
    // an evicted sample cannot validate a later update about its old location.
    if (state.indexedSamples.size > 512) state.indexedSamples.delete(state.indexedSamples.keys().next().value!);
  }

  private validateFrameHeader(state: RoleState, header: LocmafFrameHeader): void {
    const expected = state.track.role === 'video' ? 'vide' : 'soun';
    if (header.context.handlerType !== expected || header.context.codecFourcc !== state.track.seed.format.codec?.split('.')[0]
        || !equalBytes(header.description ?? new Uint8Array(), state.track.seed.requested)) {
      throw new Error(`Historical ${state.track.role} initialization differs from the installed decoder configuration`);
    }
  }
  private frameSamples(state: RoleState, object: Extract<MoqtObject, { kind: 'data' }>) {
    let result = state.frameReader!.push(object.groupId, object.objectId, object.payload);
    if (result.kind === 'reconfigure') {
      this.validateFrameHeader(state, result.header);
      const successor = new LocmafFrameReader(result.header.bytes, frameReadLimits);
      state.frameReader = successor;
      result = successor.push(result.location.groupId, result.location.objectId, result.replay);
      if (result.kind !== 'batch') throw new Error('Historical Header replay did not stay in its initialization epoch');
    }
    if (result.header) this.validateFrameHeader(state, result.header);
    if (!state.prepared && result.continuity === 'gap') throw new Error('LOCMAF history has a missing metadata dependency');
    return locmafPlaybackSamples(state.track.role, result.units, state.track.seed.requested);
  }
  private async drainSampleInput(pipeline: PlaybackPipeline): Promise<void> {
    while (pipeline.pendingSampleCount > 0 && this.current() && !this.frozen) {
      const before = pipeline.pendingSampleCount;
      pipeline.tick(); this.maybeAdopt();
      if (pipeline.pendingSampleCount > 0) {
        if (pipeline.throttled) await this.waitForQueueProgress(pipeline);
        else if (pipeline.pendingSampleCount >= before) await this.wait();
      }
    }
    if (!this.frozen) this.assertCurrent();
  }

  private command(command: DecoderCommand): void {
    if (!this.current() || this.frozen) return;
    const dispatcher = this.graph?.pipelines.commandDispatcher;
    if (!dispatcher) return;
    const state = command.type === 'configure' ? this.roles.get(command.mediaType)! : undefined;
    const call = state ? {} : null;
    if (state) state.configurationCall = call;
    const requested = command.type === 'configure' ? new Uint8Array(command.config) : undefined;
    const current = () => this.current() && !this.frozen && (!state || state.configurationCall === call);
    const restore = state && !state.seeded && command.type === 'configure' && equalBytes(command.config, state.track.seed.requested);
    if (restore) state.seeded = true;
    let dispatched: DecoderCommand | undefined;
    const format = handlePipelineCommand(restore && command.type === 'configure' ? { ...command, config: new Uint8Array(state.track.seed.configured) } : command,
      restore ? undefined : this.options.config.commandTransform, dispatcher, null,
      event => { dispatched = event.command as DecoderCommand; this.options.onCommand(dispatched); }, undefined, current);
    const actual = dispatched as DecoderCommand | undefined;
    if (current() && state && requested && actual?.type === 'configure' && actual.mediaType === state.track.role && format?.mediaType === state.track.role) {
      state.configuration = { dispatcher, requested, configured: format.config, format };
      if (this.adopted) this.options.onConfiguration(state.track.role, state.configuration);
    }
  }

  private maybeAdopt(): void {
    if (!this.current() || this.adopted) return;
    if (this.roles.has('video') && !this.output?.hasTargetOutput) return;
    if (this.roles.has('audio') && !this.graph?.audioPreparation?.snapshotPrepared().some(item => item.timing.context.epoch === this.audioEpoch)) return;
    this.assertPreparationTime();
    // Preparation is bounded; waiting for a user-enabled output clock is not
    // preparation success and must not manufacture a position or a timeout.
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.deadline = null;
    this.adopted = true;
    this.options.adopt(this.graph!);
    if (!this.current()) return;
    this.graph!.adopt(this.playing);
    if (!this.current()) return;
    if (this.options.resume?.reference === 'audio' && this.audioBoundary !== null) {
      this.graph!.pipelines.syncController.setAudioReference(this.audioBoundary + this.audioOffset);
      if (!this.current()) return;
    }
    this.output?.activate();
    if (!this.current()) return;
    this.graph!.output.renderer?.renderTick?.(this.options.clock.now());
    this.activateAudio();
  }
  private activateAudio(): void {
    if (!this.adopted || !this.playing || !this.current() || this.frozen
        || this.output && !this.output.firstPresented && this.options.resume?.reference !== 'audio') return;
    if (!this.output && !this.graph!.pipelines.syncController.hasReference && this.audioBoundary !== null) this.graph!.pipelines.syncController.setAudioReference(this.audioBoundary);
    if (this.current()) this.graph?.audioPreparation?.activate();
  }
  private reportPosition(time: number, location: Options['location']): void {
    if (!this.current() || this.positioned) return;
    this.positioned = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.options.onPosition(time, location);
  }
  private snapshotResumePoint(): LocSeekResume | null {
    const video = this.roles.get('video'), audio = this.roles.get('audio');
    const source = this.output?.captureSourcePosition();
    if (!this.current()) return null;
    const audioReference = this.lastAudioPoint ?? (this.options.resume?.reference === 'audio' ? this.options.resume.point : null);
    const point = audioReference ?? (source && video?.placement ? snapshotLocResumePoint({ source, placement: video.placement }) : null);
    return point ? Object.freeze({ point, reference: audioReference ? 'audio' : 'video',
      ...(video?.placement ? { videoPlacement: snapshotLocIndexedPlacement(video.placement) } : {}),
      ...(audio?.placement ? { audioPlacement: snapshotLocIndexedPlacement(audio.placement) } : {}),
      ...this.snapshotMappings() }) : null;
  }
  private snapshotMappings(): Pick<LocSeekResume, 'videoMapping' | 'audioMapping'> {
    const video = this.roles.get('video')?.mapping, audio = this.roles.get('audio')?.mapping;
    return { ...(video ? { videoMapping: snapshotLocTimelineMapping(video) } : {}),
      ...(audio ? { audioMapping: snapshotLocTimelineMapping(audio) } : {}) };
  }
  private finishRoleInput(state: RoleState): Promise<void> {
    if (state.endWork) return state.endWork;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const work = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    state.endWork = work; state.inputEnding = true;
    void work.catch(() => {});
    void this.finishInput(state).then(resolve, error => {
      try { this.fail(error); }
      catch (failure) { reject(new AggregateError([error, failure], 'LOC input completion failed')); return; }
      reject(error);
    });
    return work;
  }
  private async finishInput(state: RoleState): Promise<void> {
    if (this.frozen) return;
    const pipeline = this.pipeline(state.track.role)!;
    pipeline.endBufferedGroups();
    while ((pipeline.bufferedGroupCount > 0 || pipeline.pendingSampleCount > 0) && this.current() && !this.frozen) {
      if (pipeline.throttled) await this.waitForQueueProgress(pipeline);
      else await this.wait();
    }
    if (this.frozen) return;
    this.assertCurrent(); await this.decoder(state.track.role)!.flush(); this.assertCurrent();
    while (this.current() && !this.frozen && (state.track.role === 'video' ? (this.output?.pendingOutputCount ?? 0) > 0 : (this.graph?.audioPreparation?.retainedChunkCount ?? 0) > 0)) await this.wait();
    if (this.frozen) return;
    this.assertCurrent(); const release = state.releaseEnd; state.releaseEnd = null;
    release?.(true); pipeline.tick();
  }
  private assertPreparationTime(): void {
    if (this.deadline !== null && performance.now() >= this.deadline) throw new Error('LOC seek media preparation timed out');
  }
  private trackInfo(): TrackInfo {
    const video = this.roles.get('video')?.track, audio = this.roles.get('audio')?.track;
    return { video: video?.role === 'video' ? video.info : undefined, audio: audio?.role === 'audio' ? audio.info : undefined, isLive: false };
  }
  private pipeline(role: Role): PlaybackPipeline | null { return this.graph?.pipelines[role === 'video' ? 'videoPipeline' : 'audioPipeline'] ?? null; }
  private decoder(role: Role) { return this.graph?.output[role === 'video' ? 'videoDecoder' : 'audioDecoder']; }
  private current(): boolean { return !this.stopped && this.options.isCurrent() && !this.stopped; }
  private assertCurrent(): void { if (!this.current()) throw abortError(); }
  private wake(): void {
    if (this.pressureTimer !== null) { clearTimeout(this.pressureTimer); this.pressureTimer = null; }
    if (!this.wakeups.size) return;
    const wakeups = [...this.wakeups]; this.wakeups.clear(); for (const wake of wakeups) wake();
  }
  private async waitForQueueProgress(pipeline: PlaybackPipeline): Promise<void> {
    this.graph?.pipelines.commandDispatcher?.resampleQueuePressure();
    this.assertCurrent();
    if (this.frozen || !pipeline.throttled) return;
    const role = pipeline === this.pipeline('video') ? 'video' : 'audio';
    if (this.graph?.pipelines.commandDispatcher?.hasQueueProgressObserver(role) || this.adopted && !this.playing) {
      await this.wait(); return;
    }
    // Legacy adapters expose only a queue-depth getter. One bounded fallback
    // timer wakes all pressure waiters; elapsed time is never output evidence.
    if (this.pressureTimer === null) this.pressureTimer = setTimeout(() => { this.pressureTimer = null; this.wake(); }, 10);
    await this.wait();
  }
  private async wait(): Promise<void> { this.assertCurrent(); await new Promise<void>(resolve => this.wakeups.add(resolve)); this.assertCurrent(); }
  private fail(error: unknown, frozenPolicy: 'ignore' | 'retire' = 'ignore'): void {
    if (!this.current() || this.frozen && frozenPolicy === 'ignore') return;
    let cause = error instanceof Error ? error : new Error('LOC seek preparation failed', { cause: error });
    try { this.cancel(); } catch (cleanup) { cause = new AggregateError([cause, cleanup], 'LOC seek preparation and cleanup failed'); }
    if (this.options.isCurrent()) this.options.onError(cause);
  }
}
