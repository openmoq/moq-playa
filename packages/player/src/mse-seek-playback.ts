import type { SeekTrack, SeekInputReceiver, SeekLiveInput, SeekGroupPageAcceptance } from './seek-retrieval-contracts.js';
export type { SeekTrack, SeekInputReceiver, SeekLiveInput, SeekGroupPageAcceptance } from './seek-retrieval-contracts.js';
import { nativeTimeUs, type FractionUs } from './presentation-placement.js';
import type { MoqtObject } from '@openmoq/transport';
import type { DataStreamTerminal } from '@openmoq/webtransport';
import type { MoqtPlayerConfig } from './config.js';
import type { CmafAssemblerLike, MediaAppendReason, MediaSeekResource, MediaSeekSample, MediaSourceLike } from './interfaces.js';
import { MseSeekOutput, type MseSeekRoleSuspension } from './mse-seek-output.js';
import { SEEK_INTERVAL_BYTES, SeekCmafInput, seekChunkCoverage, type SeekCmafChunk, type SeekSampleInterval } from './seek-cmaf-input.js';
import type { SeekFetchCut } from './seek-fetch-pages.js';

type Role = 'video' | 'audio';
type AssemblyCallbacks = Parameters<NonNullable<MoqtPlayerConfig['createCmafAssembler']>>[0];
type Placement = NonNullable<Parameters<NonNullable<CmafAssemblerLike['setPresentationPlacement']>>[1]>;
interface CommonRolePreparation {
  readonly track: SeekTrack;
  readonly location: Options['location'];
  readonly mediaPts: number;
  readonly timestampRounding: Options['timestampRounding'];
  readonly placement: Placement;
  readonly onPageDrained: (page: object, scope?: 'prepared' | 'native') => void;
  readonly onPageError: (page: object, error: Error) => void;
  readonly onError: (error: Error) => void;
  /** Admission for the retained role, including after promotion. */
  readonly isCurrent?: () => boolean;
}
export type SeekRolePreparation = CommonRolePreparation & (
  | { readonly targetMs: number; readonly readiness?: 'target' }
  | { readonly readiness: 'indexed-boundary'; readonly targetMs?: never }
  | { readonly readiness: 'indexed-group'; readonly targetMs?: never }
);
export interface SeekRoleGroupProof {
  readonly resource: object;
  readonly epoch: object;
  readonly location: Options['location'];
  readonly source: { readonly namespace: readonly string[]; readonly name: string; readonly sourceKey: string };
  readonly placement: Placement;
  readonly nativeOffsetUs: FractionUs;
  readonly sourcePtsUs: FractionUs;
  readonly nativeSample: SeekRoleBoundary['nativeSample'];
  readonly coverage: readonly { readonly startUs: FractionUs; readonly endUs: FractionUs }[];
  readonly closedBy: 'later-group' | 'range-fin' | 'track-end';
}
export interface SeekRoleBoundary {
  readonly sourcePtsUs: FractionUs;
  readonly nativeSample: { readonly startUs: FractionUs; readonly endUs: FractionUs };
  /** Minimum of parsed prepared presentation starts, not continuous min/max coverage. */
  readonly earliestNativeUs: FractionUs;
}
export interface SeekRoleCandidate {
  readonly ready: Promise<void>;
  /** Indexed-boundary mode only; an observation, not current admission authority. */
  readonly boundary: SeekRoleBoundary | null;
  readonly groupProof: SeekRoleGroupProof | null;
  /** Retained consumer health after promotion; request failure alone is not reset authority. */
  readonly requiresReset: boolean;
  beginPage(identity: object): SeekInputReceiver;
  acceptPage(identity: object, endOfTrack: boolean, receipt?: SeekGroupPageAcceptance): void;
  beginLive(owner: object): SeekLiveInput;
  /** Cancels preparation only; promotion transfers ownership to the actor. */
  cancel(): void;
}
export interface SeekRoleHold {
  readonly current: boolean;
  readonly nativeSettled: Promise<void>;
  resume(): void;
  commit(candidate: SeekRoleCandidate): void;
}
export interface SeekRoleCutHold extends SeekRoleHold {
  readonly reached: Promise<{ readonly groupId: bigint; readonly objectId: bigint }>;
  readonly frontier: SeekSubmissionFrontier | null;
}
export interface SeekSubmissionFrontier {
  readonly owner: object;
  readonly sourceKey: string;
  readonly resource: object;
  readonly epoch: object;
  readonly revision: object;
  readonly placement: Placement;
  readonly nativeOffsetUs: FractionUs;
  readonly highestSubmittedGroup: bigint | null;
  readonly maxSubmittedEndUs: FractionUs | null;
}
function freezePlacement(value: Placement): Placement {
  return Object.freeze({ sourceTimeUs: value.sourceTimeUs, rebasedTimeUs: Object.freeze({ ...value.rebasedTimeUs }) });
}
function gate<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Candidate {
  readonly options: SeekRolePreparation;
  readonly offset: number;
  readonly offsetUs: FractionUs;
  indexedSample: Pick<SeekRoleBoundary, 'sourcePtsUs' | 'nativeSample'> | null;
  earliestNativeUs: FractionUs | null;
  boundary: SeekRoleBoundary | null;
  readonly ready: ReturnType<typeof gate<void>>;
  readonly promotion: ReturnType<typeof gate<void>>;
  handle: SeekRoleCandidate | null;
  usable: boolean;
  promoted: boolean;
  processingFailed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  readonly group: {
    next: SeekFetchCut;
    intervals: SeekSampleInterval[];
    factBytes: number;
    proof: SeekRoleGroupProof | null;
    floor: FractionUs | null;
    failed: boolean;
    knownPastGroup: boolean;
  } | null;
}
interface Hold {
  readonly gate: ReturnType<typeof gate<void>>;
  readonly native: ReturnType<typeof gate<void>>;
  lease: MseSeekRoleSuspension | null;
  settled: boolean;
  readonly cut: {
    readonly beforeGroup: bigint;
    readonly reached: ReturnType<typeof gate<{ readonly groupId: bigint; readonly objectId: bigint }>>;
    atBoundary: boolean;
    frontier: SeekSubmissionFrontier | null;
    readonly credit: { rawObjects: number; rawBytes: number; mediaBytes: number } | null;
  } | null;
}
type CutOptions = { readonly beforeGroup: bigint; readonly readCredit?: 'bounded-preparation' };
/** Cost of existing queued/active work, not another media buffer. */
interface InputWork {
  rawObjects: number;
  rawBytes: number;
  rawCut: Hold | null;
  batchBytes: number;
  batchCut: Hold | null;
}
function inputWork(): InputWork { return { rawObjects: 0, rawBytes: 0, rawCut: null, batchBytes: 0, batchCut: null }; }
interface LiveItem {
  readonly object: MoqtObject;
  readonly input: object | undefined;
  readonly admitted: (() => boolean) | undefined;
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  inputOwned: boolean;
}
interface Live {
  readonly owner: object;
  state: 'open' | 'ending' | 'ended' | 'cancelled' | 'failed';
  readonly queued: LiveItem[];
  active: LiveItem | null;
  retainedObjects: number;
  retainedBytes: number;
  work: Promise<void> | null;
  end: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null;
}
interface Page {
  readonly identity: object;
  readonly early: { object: MoqtObject; input: object | undefined }[];
  readonly cancellation: AbortController;
  earlyBytes: number;
  accepted: boolean;
  endOfTrack: boolean;
  fin: boolean;
  failed: boolean;
  work: Promise<void> | null;
  receipt: SeekGroupPageAcceptance | null;
}
interface Output {
  readonly work: InputWork;
  retainedRawObjects: number;
  retainedRawBytes: number;
  highestEnteredGroup: bigint | null;
  placement: Placement | null;
  offset: number | null;
  readonly lifetime: AbortController;
  candidate: Candidate | null;
  hold: Hold | null;
  retired: boolean;
  nativeRetired: boolean;
  submitting: boolean;
  readonly track: SeekTrack;
  readonly input: SeekCmafInput;
  prepared: boolean;
  covered: boolean;
  ended: boolean;
  page: Page | null;
  live: Live | null;
  readonly queued: SeekCmafChunk[];
  queuedBytes: number;
  preparationObjects: number;
  preparationBytes: number;
}
export interface MseSeekAdoption {
  readonly resource: MediaSeekResource;
  readonly assembler: CmafAssemblerLike;
}
export interface CmafAppendObservation {
  readonly token: object | undefined;
  discard(reason: MediaAppendReason): void;
}
interface Options {
  readonly epoch: object;
  readonly source: MediaSourceLike;
  readonly liveAssembler: CmafAssemblerLike;
  readonly createAssembler: NonNullable<MoqtPlayerConfig['createCmafAssembler']>;
  readonly tracks: readonly SeekTrack[];
  readonly location: { readonly groupId: bigint; readonly objectId: bigint };
  readonly mediaPts: number;
  readonly timestampRounding: 'nearest' | 'floor';
  readonly targetMs: number;
  readonly maxObjects: number;
  readonly maxBytes: number;
  readonly preparationTimeoutMs: number;
  readonly playing: boolean;
  readonly isCurrent: () => boolean;
  /** Retire the previous input lease immediately before the native resource changes. */
  readonly beforeResourceChange: () => void;
  /** Ownership transfers on invocation, before any callback can reenter or throw. */
  readonly adopt: (owned: MseSeekAdoption) => void;
  /** Player-owned steady-state routing after transfer; historical input is captured locally while active. */
  readonly onSegment: AssemblyCallbacks['onSegment'];
  readonly onDiscard?: AssemblyCallbacks['onDiscard'];
  readonly onDiscontinuity?: AssemblyCallbacks['onDiscontinuity'];
  readonly onPosition: (sample: MediaSeekSample) => void;
  /** Matching OK, FIN and accepted work settled; this is not a presentation witness. */
  readonly onPageDrained: (role: Role, page: object) => void;
  readonly onPageError: (role: Role, page: object, error: Error) => void;
  readonly onError: (error: Error) => void;
  readonly observeAppend?: (inputs: readonly (object | undefined)[] | undefined) => CmafAppendObservation | undefined;
  readonly onSubmitted?: (role: Role) => void;
}

/** A bounded historical media consumer; transport addressing and live continuation stay with its owner. */
export class MseSeekPlayback {
  private readonly outputs = new Map<Role, Output>();
  private readonly candidates = new Map<Role, Output>();
  private assembler: CmafAssemblerLike | null = null;
  private native: MediaSeekResource | null = null;
  private output: MseSeekOutput | null = null;
  private active: { output: Output; assertOwner: () => void; chunks: SeekCmafChunk[]; inputs: SeekCmafChunk['inputs'] } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private started = false;
  private adopting = false;
  private resourcesTransferred = false;
  private releaseAssemblyBridge: ((transferred: boolean) => void) | null = null;
  private playing: boolean;
  private readonly prepared: Promise<void>;
  private preparedResolve!: () => void;
  private preparedReject!: (error: Error) => void;

  constructor(private readonly options: Options) {
    if (!options.source.beginSeek) throw new Error('Media adapter cannot establish an owned seek resource');
    if (!Number.isFinite(options.targetMs) || options.targetMs < options.mediaPts
        || !Number.isFinite(options.preparationTimeoutMs) || options.preparationTimeoutMs <= 0) throw new RangeError('Invalid seek target or preparation deadline');
    if (!options.tracks.length || options.tracks.length > 2) throw new Error('Seek requires selected media outputs');
    for (const track of options.tracks) {
      if (this.outputs.has(track.role)) throw new Error('Seek requires distinct media roles');
      this.outputs.set(track.role, { track, work: inputWork(), retainedRawObjects: 0, retainedRawBytes: 0, highestEnteredGroup: null, placement: null, offset: null, lifetime: new AbortController(), candidate: null, hold: null, retired: false, nativeRetired: false, submitting: false, prepared: false, covered: false, ended: false, page: null, live: null,
        queued: [], queuedBytes: 0, preparationObjects: 0, preparationBytes: 0, input: new SeekCmafInput({
        init: track.init, packaging: track.packaging, role: track.role, location: options.location, mediaPts: options.mediaPts, timestampRounding: options.timestampRounding,
        maxObjects: options.maxObjects, maxBytes: options.maxBytes,
        ...(options.onDiscard ? { onDiscard: options.onDiscard } : {}),
      }) });
    }
    this.playing = options.playing;
    this.prepared = new Promise<void>((resolve, reject) => { this.preparedResolve = resolve; this.preparedReject = reject; });
    // Cancellation may precede the first Object (and therefore every waiter).
    void this.prepared.catch(() => {});
  }

  /** Install before opening requests; the engine owns their writes and cancellation. */
  start(): void {
    if (this.started || !this.current()) throw new Error('Seek preparation is not current or already started');
    this.started = true;
    this.timer = setTimeout(() => this.fail(new Error('Seek media preparation timed out')), this.options.preparationTimeoutMs);
  }

  /** The owner supplies a fresh identity for each ordered request. */
  beginPage(role: Role, identity: object): SeekInputReceiver {
    const output = this.outputs.get(role);
    if (!output) throw new Error('Seek role was not selected');
    return this.beginOutputPage(output, identity);
  }

  private beginOutputPage(output: Output, identity: object): SeekInputReceiver {
    this.assertOutput(output);
    if (!this.started) throw new Error('Seek playback has not started');
    if (output.candidate?.group?.failed) throw new Error('Target group consumer requires reset after a floor violation');
    if (!output || output.ended) throw new Error('Seek role has ended or was not selected');
    if (output.live) throw new Error('Seek role has entered live input');
    if (output.prepared && !output.input.ready) throw new Error('Seek format consumer requires reset');
    if (output.page && (!output.page.failed || output.page.work)) throw new Error('Previous seek page has not drained');
    const page: Page = { identity, early: [], earlyBytes: 0, accepted: false, endOfTrack: false,
      fin: false, failed: false, work: null, receipt: null, cancellation: new AbortController() };
    output.page = page;
    return { onObject: (object, input) => this.receive(output, page, object, input),
      onClosed: terminal => this.finish(output, page, terminal) };
  }

  /** Keeps the adopted consumer; the engine owns live ordering and stream admission. */
  beginLive(role: Role, owner: object): SeekLiveInput {
    const output = this.outputs.get(role);
    if (!output) throw new Error('Seek role was not selected');
    return this.beginOutputLive(output, owner);
  }

  private beginOutputLive(output: Output, owner: object): SeekLiveInput {
    this.assertOutput(output);
    if (output.candidate?.group?.failed) throw new Error('Target group consumer requires reset after a floor violation');
    if (!this.installed(output) || !this.output || !this.resourcesTransferred || !this.native?.current) throw new Error('Seek output has not been adopted');
    this.assertCurrent();
    if (!output || output.ended) throw new Error('Seek role has ended or was not selected');
    if (output.page || output.queued.length) throw new Error('Previous seek page has not drained');
    if (output.hold?.cut) throw new Error('An indexed cut requires ordered historical input');
    if (!output.input.ready) throw new Error('Seek format consumer requires reset');
    const previous = output.live;
    if (previous?.state === 'open' || previous?.state === 'ending') throw new Error('Seek role already has a live owner');
    if (previous?.active) throw new Error('Previous live work is still settling');
    const live: Live = { owner, state: 'open', queued: [], active: null, retainedObjects: 0, retainedBytes: 0, work: null, end: null };
    output.live = live;
    return { onObject: (object, input, admitted) => this.receiveLive(output, live, object, input, admitted),
      endTrack: () => this.endLive(output, live), cancel: () => this.stopLive(output, live, this.aborted(), 'cancelled') };
  }

  acceptPage(role: Role, identity: object, endOfTrack: boolean): void {
    const output = this.outputs.get(role);
    if (output) this.acceptOutputPage(output, identity, endOfTrack);
  }

  private acceptOutputPage(output: Output, identity: object, endOfTrack: boolean, receipt?: SeekGroupPageAcceptance): void {
    const page = output.page;
    if (!output || !page || page.identity !== identity || !this.pageCurrent(output, page) || page.accepted) return;
    const group = output.candidate?.group;
    if (group && !output.candidate!.promoted) {
      try {
        if (!receipt || receipt.groupOrder !== 'ascending' || receipt.rangeFilters !== false || receipt.endOfTrack !== endOfTrack) throw new Error('Target group needs accepted unfiltered ascending FETCH provenance');
        const snapshot: SeekGroupPageAcceptance = Object.freeze({ start: Object.freeze({ ...receipt.start }),
          through: Object.freeze({ ...receipt.through }), endOfTrack, groupOrder: 'ascending', rangeFilters: false });
        if (group.next.kind !== 'before' || snapshot.start.groupId !== group.next.groupId || snapshot.start.objectId !== group.next.objectId) throw new Error('Target group pages do not cover a contiguous prefix');
        if (snapshot.through.groupId < snapshot.start.groupId || snapshot.through.groupId === snapshot.start.groupId
            && snapshot.through.kind === 'before' && snapshot.through.objectId < snapshot.start.objectId) throw new Error('Target group response precedes its start');
        if (!this.pageCurrent(output, page) || output.page !== page || output.candidate?.group !== group || page.accepted) return;
        page.receipt = snapshot;
      } catch (error) { if (this.pageCurrent(output, page)) this.failPage(output, page, error); return; }
    }
    page.accepted = true; page.endOfTrack = endOfTrack;
    void this.progress(output, page);
  }

  roleOwner(role: Role): object | null {
    const output = this.outputs.get(role);
    return output && this.outputCurrent(output) ? output : null;
  }

  /** Submission facts for the current binding; neither native settlement nor a cut witness. */
  submissionFrontier(role: Role, expectedOwner: object): SeekSubmissionFrontier | null {
    const output = this.outputs.get(role);
    if (!output || output !== expectedOwner || !this.outputCurrent(output)) return null;
    const native = this.native, sink = this.output, placement = output.placement, lockedOffset = output.offset;
    const frontier = sink?.submissionFrontier(role);
    if (!native || !sink || !placement || !frontier || !this.resourcesTransferred) return null;
    try {
      const resource = native.resource, epoch = native.epoch;
      if (!native.current || !this.outputCurrent(output)) return null;
      const offset = native.getTimestampOffset(role), offsetUs = nativeTimeUs(offset);
      if (!native.current || !this.outputCurrent(output)) return null;
      // Native accessors can promote a replacement. Keep the final check pure.
      if (!offsetUs || lockedOffset !== null && !Object.is(offset, lockedOffset)
          || this.closed || output.retired || this.outputs.get(role) !== output
          || this.native !== native || this.output !== sink || output.placement !== placement || output.offset !== lockedOffset
          || sink.submissionFrontier(role) !== frontier) return null;
      return Object.freeze({ owner: output, sourceKey: output.track.sourceKey, resource, epoch, placement,
        nativeOffsetUs: Object.freeze(offsetUs), ...frontier });
    } catch { return null; }
  }

  prepareRole(options: SeekRolePreparation): SeekRoleCandidate {
    this.assertAdopted();
    const old = this.outputs.get(options.track.role);
    if (!old || !this.outputCurrent(old)) throw new Error('Seek role was not selected');
    if (this.candidates.has(options.track.role)) throw new Error('Seek role already has a candidate');
    this.sameConfiguration(old.track, options.track);
    const groupMode = options.readiness === 'indexed-group', boundaryMode = options.readiness === 'indexed-boundary' || groupMode;
    if ((boundaryMode ? options.targetMs !== undefined : !Number.isFinite(options.targetMs) || options.targetMs < 0)
        || typeof options.placement.sourceTimeUs !== 'bigint'
        || typeof options.placement.rebasedTimeUs.numerator !== 'bigint'
        || typeof options.placement.rebasedTimeUs.denominator !== 'bigint'
        || options.placement.rebasedTimeUs.denominator <= 0n) throw new RangeError('Invalid target presentation placement');
    const offset = this.native!.getTimestampOffset(options.track.role);
    this.assertAdopted();
    if (typeof offset !== 'number' || !Number.isFinite(offset) || this.outputs.get(old.track.role) !== old || this.candidates.has(old.track.role)) throw this.aborted();
    const snapshot: SeekRolePreparation = { ...options, location: { ...options.location },
      track: { ...options.track, namespace: [...options.track.namespace], init: options.track.init.slice() },
      placement: { sourceTimeUs: options.placement.sourceTimeUs, rebasedTimeUs: { ...options.placement.rebasedTimeUs } } };
    const candidate: Candidate = { options: snapshot, offset, offsetUs: nativeTimeUs(offset)!, indexedSample: null, earliestNativeUs: null, boundary: null, ready: gate(), promotion: gate(), handle: null,
      usable: false, promoted: false, processingFailed: false, timer: null, group: groupMode ? {
        next: { kind: 'before', groupId: snapshot.location.groupId, objectId: 0n }, intervals: [], factBytes: 0, proof: null, floor: null, failed: false, knownPastGroup: false } : null };
    const output: Output = { track: snapshot.track, work: inputWork(), retainedRawObjects: 0, retainedRawBytes: 0, highestEnteredGroup: null, placement: freezePlacement(snapshot.placement), offset, lifetime: new AbortController(), candidate, hold: null,
      retired: false, nativeRetired: false, submitting: false, prepared: false, covered: false, ended: false,
      page: null, live: null, queued: [], queuedBytes: 0, preparationObjects: 0, preparationBytes: 0,
      input: new SeekCmafInput({ init: snapshot.track.init, packaging: snapshot.track.packaging, role: snapshot.track.role,
        location: snapshot.location, mediaPts: snapshot.mediaPts, timestampRounding: snapshot.timestampRounding,
        retainTiming: boundaryMode, retainIntervals: groupMode, indexedGroupStart: groupMode,
        maxObjects: this.options.maxObjects, maxBytes: this.options.maxBytes,
        ...(this.options.onDiscard ? { onDiscard: (input, reason) => {
          // Format retirement precedes its discard observers and the push catch.
          if (!output.input.ready) candidate.processingFailed = true;
          return this.options.onDiscard!(input, reason);
        } } : {}) }) };
    this.candidates.set(output.track.role, output);
    const actor = this;
    const handle: SeekRoleCandidate = { ready: candidate.ready.promise,
      get boundary() { return output.retired ? null : candidate.boundary; },
      get groupProof() { return output.retired ? null : candidate.group?.proof ?? null; },
      get requiresReset() { return candidate.promoted && (candidate.processingFailed || candidate.group?.failed === true || !output.input.ready || actor.closed || output.retired); },
      beginPage: identity => this.beginOutputPage(output, identity),
      acceptPage: (identity, end, receipt) => this.acceptOutputPage(output, identity, end, receipt),
      beginLive: owner => this.beginOutputLive(output, owner),
      cancel: () => { if (!candidate.promoted) this.cancelCandidate(output, this.aborted()); } };
    candidate.handle = handle;
    candidate.timer = setTimeout(() => {
      if (!this.outputCurrent(output) || candidate.promoted) return;
      const error = new Error('Seek role preparation timed out'); this.cancelCandidate(output, error);
      if (this.current() && this.candidateAdmitted(candidate)) this.observeError(() => snapshot.onError(error));
    }, this.options.preparationTimeoutMs);
    if (!this.outputCurrent(output)) { this.cancelCandidate(output, this.aborted()); throw this.aborted(); }
    return Object.freeze(handle);
  }

  holdRole(role: Role, expectedOwner: object, cut: CutOptions): SeekRoleCutHold;
  holdRole(role: Role, expectedOwner: object): SeekRoleHold;
  holdRole(role: Role, expectedOwner: object, cut?: CutOptions): SeekRoleHold | SeekRoleCutHold {
    const beforeGroup = cut?.beforeGroup, readCredit = cut?.readCredit;
    this.assertAdopted();
    const output = this.outputs.get(role);
    if (!output || output !== expectedOwner || !this.outputCurrent(output)) throw this.aborted();
    const native = this.native, sink = this.output;
    if (output.hold) throw new Error('Seek role is already held');
    if (cut) {
      if (typeof beforeGroup !== 'bigint' || beforeGroup < 0n) throw new RangeError('Invalid indexed cut group');
      if (readCredit !== undefined && readCredit !== 'bounded-preparation') throw new Error('Unknown indexed cut read-credit policy');
      if (output.live) throw new Error('An indexed cut requires ordered historical input');
      const frontier = sink!.submissionFrontier(role)!;
      if (frontier.highestSubmittedGroup !== null && beforeGroup <= frontier.highestSubmittedGroup) throw new Error('Indexed cut crosses the submitted frontier');
      if (output.highestEnteredGroup !== null && beforeGroup <= output.highestEnteredGroup) throw new Error('Indexed cut group has already entered the parser');
    }
    if (this.closed || this.outputs.get(role) !== output || output.retired || output.hold || this.native !== native || this.output !== sink) throw this.aborted();
    const hold: Hold = { gate: gate(), native: gate(), lease: null, settled: false,
      cut: typeof beforeGroup === 'bigint' ? { beforeGroup, reached: gate(), atBoundary: false, frontier: null,
        credit: readCredit === 'bounded-preparation' ? { rawObjects: 0, rawBytes: 0, mediaBytes: 0 } : null } : null };
    output.hold = hold;
    this.prepareCredit(output);
    // A native accessor may reenter while append() is registering its token.
    // Install the output lease when that synchronous registration returns.
    if (!output.submitting) { const error = this.installHold(output, hold); if (error) throw error; }
    const current = () => this.holdCurrent(output, hold) && output.hold === hold && !output.retired && !this.closed;
    const methods = { nativeSettled: hold.native.promise, resume: () => this.resumeHold(output, hold),
      commit: (candidate: SeekRoleCandidate) => this.commitRole(output, hold, candidate) };
    if (hold.cut) return Object.freeze({ ...methods, get current() { return current(); }, reached: hold.cut.reached.promise,
      get frontier() { return !output.retired && output.hold === hold ? hold.cut!.frontier : null; } });
    return Object.freeze({ ...methods, get current() { return current(); } });
  }

  private resumeHold(output: Output, hold: Hold): void {
    if (!this.holdCurrent(output, hold) || output.hold !== hold) return;
    // Revoke this gate before native/current access can install a successor.
    output.hold = null; hold.cut?.reached.reject(this.aborted()); hold.native.reject(this.aborted()); hold.gate.resolve();
    const submitting = output.submitting; output.submitting = true;
    try { this.output?.clearPreparationReadCredit(output.track.role, hold); hold.lease?.resume(); }
    finally {
      output.submitting = submitting;
      if (!submitting && output.hold) this.installHold(output, output.hold);
    }
    if (this.outputCurrent(output) && output.page && !output.page.failed && !output.page.work) void this.progress(output, output.page);
  }

  private installed(output: Output): boolean { return this.outputs.get(output.track.role) === output; }
  private candidateAdmitted(candidate: Candidate): boolean {
    try { return candidate.options.isCurrent?.() !== false; } catch { return false; }
  }
  private outputCurrent(output: Output): boolean {
    const bound = () => !output.retired && (this.installed(output) || this.candidates.get(output.track.role) === output);
    return this.current() && bound() && (!output.candidate || this.candidateAdmitted(output.candidate)) && this.current() && bound();
  }
  private assertOutput(output: Output): void {
    if (this.outputCurrent(output)) return;
    if (output.candidate && !output.candidate.promoted) this.cancelCandidate(output, this.aborted());
    throw this.aborted();
  }
  private assertAdopted(): void {
    this.assertCurrent(); const native = this.native;
    if (!this.output || !this.resourcesTransferred || !native?.current) throw new Error('Seek output has not been adopted');
    this.assertCurrent(); if (this.native !== native) throw this.aborted();
  }
  private sameConfiguration(old: SeekTrack, target: SeekTrack): void {
    if (old.codec !== target.codec) throw new Error('Role replacement requires the same codec');
    if (old.init.length !== target.init.length || old.init.some((value, i) => value !== target.init[i])) {
      throw new Error('Role replacement requires the same initialization');
    }
  }
  private installHold(output: Output, hold: Hold): Error | undefined {
    if (hold.cut && !hold.cut.atBoundary) return;
    if (output.hold !== hold || hold.lease || !this.outputCurrent(output)) return;
    try {
      const lease = this.output!.suspendRole(output.track.role); hold.lease = lease;
      if (!this.outputCurrent(output) || output.hold !== hold) { lease.resume(); return; }
      this.output!.clearPreparationReadCredit(output.track.role, hold);
      void lease.nativeSettled.then(() => {
        if (!this.holdCurrent(output, hold)) return;
        const frontier = hold.cut ? this.submissionFrontier(output.track.role, output) : null;
        if (hold.cut && !frontier) { hold.native.reject(new Error('Indexed cut submission context is unavailable')); return; }
        if (!this.holdCurrent(output, hold)) return;
        if (this.closed || output.retired || this.outputs.get(output.track.role) !== output || output.hold !== hold || hold.lease !== lease
            || frontier && this.output?.submissionFrontier(output.track.role)?.revision !== frontier.revision) return;
        if (hold.cut) hold.cut.frontier = frontier;
        hold.settled = true; hold.native.resolve();
      }, error => hold.native.reject(error)).catch(error => hold.native.reject(error));
    } catch (error) {
      if (!hold.cut && output.hold === hold) { output.hold = null; hold.gate.resolve(); }
      const failure = error instanceof Error ? error : new Error(String(error));
      hold.native.reject(failure); return failure;
    }
  }
  private holdCurrent(output: Output, hold: Hold): boolean {
    if (output.hold !== hold) return false;
    if (!this.outputCurrent(output)) {
      if (!this.current()) this.cancel(); else this.retireOutput(output, this.aborted());
      return false;
    }
    const current = !hold.lease || hold.lease.current;
    if (!current && output.hold === hold) { this.cancel(); return false; }
    return current && output.hold === hold && this.outputCurrent(output);
  }
  private async admitted(output: Output, assertOwner: () => void): Promise<void> {
    assertOwner();
    while (this.blocked(output)) { await this.waitSignal(output.lifetime.signal, output.hold!.gate.promise); assertOwner(); }
  }
  private blocked(output: Output): boolean { return !!output.hold && (!output.hold.cut || output.hold.cut.atBoundary); }

  private refuseCredit(output: Output, hold: Hold, reason: string): void {
    if (output.hold !== hold || !hold.cut?.credit) return;
    const error = new Error(`Bounded cut ${reason} budget exceeded`);
    hold.cut.reached.reject(error); hold.native.reject(error);
    this.resumeHold(output, hold);
  }

  private chargeRaw(output: Output, hold: Hold, objects: number, bytes: number): boolean {
    const credit = hold.cut?.credit;
    if (!credit || output.hold !== hold) return false;
    if (objects > this.options.maxObjects - credit.rawObjects || bytes > this.options.maxBytes - credit.rawBytes) {
      this.refuseCredit(output, hold, 'raw input'); return false;
    }
    credit.rawObjects += objects; credit.rawBytes += bytes;
    return true;
  }

  /** Charge existing work once before granting this cut any extra read credit. */
  private prepareCredit(output: Output): void {
    const hold = output.hold, credit = hold?.cut?.credit;
    if (!hold || !credit || hold.cut!.atBoundary) return;
    const work = output.work;
    if (work.rawCut !== hold) {
      if (!this.chargeRaw(output, hold, work.rawObjects, work.rawBytes)) return;
      work.rawCut = hold;
    }
    if (work.batchBytes === 0) return;
    if (work.batchCut !== hold) {
      if (work.batchBytes > this.options.maxBytes - credit.mediaBytes) { this.refuseCredit(output, hold, 'reconstructed media'); return; }
      credit.mediaBytes += work.batchBytes; work.batchCut = hold;
    }
    const sink = this.output;
    sink?.enablePreparationReadCredit(output.track.role, hold, () => !this.closed && !output.retired
      && this.outputs.get(output.track.role) === output && output.hold === hold && this.output === sink
      && output.work === work && work.rawCut === hold && work.batchCut === hold);
  }

  private pruneWork(output: Output): void {
    if (output.queued.length || output.work.batchBytes) return;
    output.work.rawObjects = output.retainedRawObjects; output.work.rawBytes = output.retainedRawBytes;
    if (!output.retainedRawObjects) output.work.rawCut = null;
  }

  /** Runs at the serial consumer frontier, never on concurrent raw receipt. */
  private async pushInput(output: Output, object: MoqtObject, input: object | undefined, assertOwner: () => void, take: () => void): Promise<SeekCmafChunk[]> {
    for (;;) {
      assertOwner();
      const hold = output.hold, group = BigInt(object.groupId);
      const candidate = output.candidate, preparation = candidate?.group;
      if (preparation && !candidate!.promoted) {
        const receipt = output.page?.receipt, id = BigInt(object.objectId);
        if (!receipt) throw new Error('Target group has no accepted request provenance');
        if (group < receipt.start.groupId || group === receipt.start.groupId && id < receipt.start.objectId || group > receipt.through.groupId
            || group === receipt.through.groupId && receipt.through.kind === 'before' && id >= receipt.through.objectId) throw new Error('Target Object is outside its accepted range');
        if (preparation.knownPastGroup && group <= candidate!.options.location.groupId) throw new Error('Target group prefix regressed after its range boundary');
        if (object.kind === 'gap') {
          if (object.status !== 0n && object.status !== 1n || object.status === 0n && !preparation.knownPastGroup) throw new Error('Target group includes unknown or unsupported range coverage');
          if (object.status === 1n && group > candidate!.options.location.groupId) preparation.knownPastGroup = true;
        }
        if (object.kind === 'data' && group > candidate!.options.location.groupId) {
          this.closeGroup(output, 'later-group');
          await this.waitSignal(output.lifetime.signal, candidate!.promotion.promise); assertOwner();
          await this.drain(output, assertOwner, () => output.retired); assertOwner();
          continue;
        }
      }
      if (hold?.cut && !hold.cut.atBoundary && group >= hold.cut.beforeGroup) {
        hold.cut.atBoundary = true;
        hold.cut.reached.resolve(Object.freeze({ groupId: group, objectId: BigInt(object.objectId) }));
        this.installHold(output, hold);
        continue;
      }
      if (this.blocked(output)) { await this.waitSignal(output.lifetime.signal, output.hold!.gate.promise); continue; }
      if (hold?.cut && output.highestEnteredGroup !== null && group < output.highestEnteredGroup) throw new Error('Indexed cut requires ascending historical input');
      const bytes = object.kind === 'data' ? object.payload.length : 0;
      if (hold?.cut?.credit && !this.chargeRaw(output, hold, 1, bytes)) continue;
      take();
      if (output.highestEnteredGroup === null || group > output.highestEnteredGroup) output.highestEnteredGroup = group;
      if (output.live) return this.parseInput(output, object, input);
      const before = output.input.retainedObjectCount;
      output.work.rawObjects++; output.work.rawBytes += bytes;
      if (hold?.cut?.credit && output.hold === hold) output.work.rawCut = hold;
      const chunks = this.parseInput(output, object, input);
      if (chunks.length) { output.retainedRawObjects = 0; output.retainedRawBytes = 0; }
      else if (output.input.retainedObjectCount > before) { output.retainedRawObjects++; output.retainedRawBytes += bytes; }
      else { output.work.rawObjects--; output.work.rawBytes -= bytes; }
      return chunks;
    }
  }
  private processingFailure(output: Output): void {
    if (output.candidate) output.candidate.processingFailed = true;
  }
  private parseInput(output: Output, object: MoqtObject, input: object | undefined): SeekCmafChunk[] {
    try { return output.input.push(object, input); }
    catch (error) { this.processingFailure(output); throw error; }
  }
  private commitRole(old: Output, hold: Hold, handle: SeekRoleCandidate): void {
    const role = old.track.role;
    if (!this.holdCurrent(old, hold)) throw this.aborted();
    const output = this.candidates.get(role), candidate = output?.candidate;
    if (!output || !candidate || candidate.handle !== handle) throw new Error('Candidate does not belong to this role owner');
    this.assertOutput(output);
    if (!candidate.usable) throw new Error('Seek role candidate is not ready');
    if (hold.cut && (!hold.cut.atBoundary || !hold.cut.frontier)) throw new Error('Indexed cut has not reached its native-settled frontier');
    if (!hold.settled || !hold.lease) throw new Error('Seek role native append has not settled');
    const lease = hold.lease, native = this.native, sink = this.output, assembler = this.assembler!;
    this.sameConfiguration(old.track, output.track);
    const offset = native!.getTimestampOffset(role);
    if (!Object.is(offset, candidate.offset)) throw new Error('Seek presentation offset changed during preparation');
    if (!this.holdCurrent(old, hold) || !this.outputCurrent(output)) throw this.aborted();
    const group = candidate.group, proof = group?.proof, floor = hold.cut?.frontier?.maxSubmittedEndUs;
    if (group) {
      if (!proof || !floor || hold.cut?.beforeGroup !== proof.location.groupId || proof.coverage.length !== 1
          || proof.resource !== hold.cut.frontier?.resource || proof.epoch !== hold.cut.frontier?.epoch
          || proof.placement !== output.placement || proof.nativeOffsetUs !== candidate.offsetUs || group.failed) throw new Error('Target group has no continuous matching cut proof');
      const interval = proof.coverage[0]!, sample = proof.nativeSample;
      if (interval.startUs.numerator * floor.denominator !== floor.numerator * interval.startUs.denominator
          || interval.endUs.numerator * interval.startUs.denominator <= interval.startUs.numerator * interval.endUs.denominator
          || sample.startUs.numerator * interval.startUs.denominator < interval.startUs.numerator * sample.startUs.denominator
          || sample.endUs.numerator * interval.endUs.denominator > interval.endUs.numerator * sample.endUs.denominator) throw new Error('Target group overlaps the native floor or leaves a presentation gap');
    }
    // Admission callbacks can consume a hold or promote another binding.
    // Keep the final identity check and publication free of external calls.
    if (this.closed || this.native !== native || this.output !== sink || this.assembler !== assembler
        || this.outputs.get(role) !== old || old.retired || old.hold !== hold || hold.lease !== lease || !hold.settled
        || this.candidates.get(role) !== output || output.retired || output.candidate !== candidate
        || candidate.handle !== handle || !candidate.usable || candidate.promoted) throw this.aborted();
    if (group && (candidate.group !== group || group.proof !== proof)) throw this.aborted();
    if (hold.cut && (!hold.cut.atBoundary || !hold.cut.frontier || hold.cut.frontier.owner !== old
        || sink!.submissionFrontier(role)?.revision !== hold.cut.frontier.revision)) throw this.aborted();
    // Publish generation ownership before any cancellation/disposal observer.
    if (group) group.floor = floor!;
    this.outputs.set(role, output); this.candidates.delete(role);
    candidate.promoted = true; this.clearCandidateTimer(candidate); old.nativeRetired = true;
    old.hold = null;
    try {
      sink!.clearPreparationReadCredit(role, hold);
      hold.gate.reject(this.aborted());
      this.retireOutput(old, this.aborted()); this.assertOutput(output);
      lease.commit(); this.assertOutput(output);
      assembler.selectTrack!(output.track.role, output.track.name, output.track.sourceKey); this.assertOutput(output);
      assembler.setInitSegment!(output.track.role, output.track.init); this.assertOutput(output);
      assembler.setPresentationPlacement!(output.track.role, output.placement!); this.assertOutput(output);
      if (group) output.input.finishGroupPreparation();
      candidate.promotion.resolve();
    } catch (error) { this.fail(error); throw error; }
  }
  private clearCandidateTimer(candidate: Candidate): void {
    if (candidate.timer !== null) clearTimeout(candidate.timer); candidate.timer = null;
  }
  private cancelCandidate(output: Output, error: Error): void {
    if (output.retired || output.candidate?.promoted) return;
    if (this.candidates.get(output.track.role) === output) this.candidates.delete(output.track.role);
    this.retireOutput(output, error);
  }
  private retireOutput(output: Output, error: Error, reason: 'epoch refused' | 'decoder reset' = 'epoch refused'): void {
    if (output.retired) return;
    output.retired = true; output.lifetime.abort(error);
    const candidate = output.candidate;
    if (candidate) {
      this.clearCandidateTimer(candidate); candidate.ready.reject(error); candidate.promotion.reject(error);
      if (candidate.group) { candidate.group.intervals = []; candidate.group.factBytes = 0; candidate.group.proof = null; }
    }
    const hold = output.hold; output.hold = null;
    if (hold) this.output?.clearPreparationReadCredit(output.track.role, hold);
    hold?.cut?.reached.reject(error);
    hold?.native.reject(error); hold?.gate.reject(error); hold?.lease?.resume();
    const page = output.page; output.page = null;
    if (page) {
      page.failed = true; page.cancellation.abort(error);
      for (const item of page.early.splice(0)) if (item.input !== undefined) this.discardInputs([item.input], reason);
      page.earlyBytes = 0;
    }
    if (output.live) this.stopLive(output, output.live, error, 'cancelled', reason);
    for (const chunk of output.queued.splice(0)) this.discardInputs(chunk.inputs, reason);
    output.queuedBytes = 0; output.input.cancel();
  }
  private observeError(callback: () => void): void {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { /* Observer cannot retain ownership. */ }
  }
  private readyCandidate(output: Output): void {
    const candidate = output.candidate;
    if (!candidate || candidate.usable || candidate.promoted || !output.prepared || !output.covered) return;
    this.assertOutput(output);
    if (candidate.group && !candidate.group.proof) return;
    if (candidate.options.readiness === 'indexed-boundary') {
      if (!candidate.indexedSample || !candidate.earliestNativeUs) throw new Error('Indexed independent boundary is unavailable');
      candidate.boundary = Object.freeze({ ...candidate.indexedSample, earliestNativeUs: candidate.earliestNativeUs });
    }
    candidate.usable = true; candidate.ready.resolve();
  }
  private placementShift(output: Output): bigint {
    const anchor = output.candidate!.options.placement, scale = BigInt(output.input.context.timescale);
    const numerator = (anchor.rebasedTimeUs.numerator - anchor.sourceTimeUs * anchor.rebasedTimeUs.denominator) * scale;
    const denominator = anchor.rebasedTimeUs.denominator * 1000000n;
    return numerator / denominator - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n);
  }
  private noteBoundary(output: Output, chunk: SeekCmafChunk): void {
    const candidate = output.candidate;
    if (!candidate || candidate.promoted || candidate.options.readiness !== 'indexed-boundary' && candidate.options.readiness !== 'indexed-group') return;
    const timing = chunk.timing;
    if (!timing) throw new Error('Parsed boundary sample facts are unavailable');
    const scale = BigInt(output.input.context.timescale), shift = this.placementShift(output), offset = candidate.offsetUs;
    const native = (ticks: bigint): FractionUs => Object.freeze({
      numerator: (ticks + shift) * 1000000n * offset.denominator + offset.numerator * scale, denominator: scale * offset.denominator });
    const earliest = native(timing.earliestPtsTicks), prior = candidate.earliestNativeUs;
    if (!prior || earliest.numerator * prior.denominator < prior.numerator * earliest.denominator) candidate.earliestNativeUs = earliest;
    const indexed = candidate.options.location;
    if (chunk.groupId !== indexed.groupId || chunk.objectId !== indexed.objectId) return;
    if (!timing.independent) throw new Error('Indexed boundary does not begin independently');
    candidate.indexedSample = { sourcePtsUs: Object.freeze({ numerator: timing.firstPtsTicks * 1000000n, denominator: scale }),
      nativeSample: Object.freeze({ startUs: native(timing.firstPtsTicks), endUs: native(timing.firstPtsTicks + timing.firstDurationTicks) }) };
  }
  private coverage(output: Output, bytes: Uint8Array, placed: boolean) {
    const candidate = output.candidate;
    if (!candidate) return seekChunkCoverage(bytes, output.input.context, this.options.targetMs);
    if (candidate.options.readiness === 'indexed-boundary' || candidate.options.readiness === 'indexed-group') {
      const evidence = seekChunkCoverage(bytes, output.input.context, undefined, candidate.group !== null);
      return { ...evidence, endTimeSeconds: evidence.endTimeSeconds + (placed ? candidate.offset : 0) };
    }
    const shiftMs = placed ? 0 : Number(this.placementShift(output)) * 1000 / output.input.context.timescale;
    const evidence = seekChunkCoverage(bytes, output.input.context, candidate.options.targetMs - candidate.offset * 1000 - shiftMs);
    return { ...evidence, endTimeSeconds: evidence.endTimeSeconds + (placed ? candidate.offset : 0) };
  }

  private nativeTicks(output: Output, ticks: bigint, placed = false, offset = output.candidate!.offsetUs): FractionUs {
    const scale = BigInt(output.input.context.timescale), value = ticks + (placed ? 0n : this.placementShift(output));
    return Object.freeze({ numerator: value * 1000000n * offset.denominator + offset.numerator * scale, denominator: scale * offset.denominator });
  }

  private noteGroup(output: Output, chunk: SeekCmafChunk): void {
    const candidate = output.candidate, group = candidate?.group;
    if (!candidate || !group || candidate.promoted) return;
    if (chunk.groupId !== candidate.options.location.groupId || group.proof) throw new Error('Media crossed the target group preparation boundary');
    const intervals = chunk.timing?.intervals;
    if (!intervals) throw new Error('Group presentation facts are unavailable');
    group.factBytes += intervals.length * SEEK_INTERVAL_BYTES;
    const base = output.queuedBytes + chunk.bytes.length + group.factBytes;
    if (base > this.options.maxBytes) throw new Error('Target group proof exceeds preparation byte budget');
    // Sort facts only, then merge linearly; never reorder encoded samples.
    const sorted = [...intervals].sort((a, b) => a.startTicks < b.startTicks ? -1 : a.startTicks > b.startTicks ? 1 : 0);
    const merged: SeekSampleInterval[] = []; let i = 0, j = 0;
    while (i < group.intervals.length || j < sorted.length) {
      const item = i < group.intervals.length && (j === sorted.length || group.intervals[i]!.startTicks <= sorted[j]!.startTicks)
        ? group.intervals[i++]! : sorted[j++]!;
      const prior = merged[merged.length - 1];
      if (prior && item.startTicks <= prior.endTicks) {
        if (item.endTicks > prior.endTicks) merged[merged.length - 1] = Object.freeze({ startTicks: prior.startTicks, endTicks: item.endTicks });
      } else {
        if (base + (merged.length + 1) * SEEK_INTERVAL_BYTES > this.options.maxBytes) throw new Error('Target group proof exceeds preparation byte budget');
        merged.push(item);
      }
    }
    group.intervals = merged;
  }

  private closeGroup(output: Output, closedBy: SeekRoleGroupProof['closedBy']): void {
    const candidate = output.candidate!, group = candidate.group!;
    if (group.proof) return;
    if (!output.input.ready || output.input.retainedObjectCount || !candidate.indexedSample || !group.intervals.length) throw new Error('Target group ended without complete indexed media');
    const native = this.native!, resource = native.resource, epoch = native.epoch;
    if (!native.current) throw this.aborted(); this.assertOutput(output);
    const coverage = Object.freeze(group.intervals.map(item => Object.freeze({ startUs: this.nativeTicks(output, item.startTicks), endUs: this.nativeTicks(output, item.endTicks) })));
    const proof: SeekRoleGroupProof = Object.freeze({ resource, epoch, location: Object.freeze({ ...candidate.options.location }),
      source: Object.freeze({ namespace: Object.freeze([...output.track.namespace]), name: output.track.name, sourceKey: output.track.sourceKey }),
      placement: output.placement!, nativeOffsetUs: candidate.offsetUs, ...candidate.indexedSample, coverage, closedBy });
    if (this.closed || output.retired || this.native !== native || this.candidates.get(output.track.role) !== output
        || output.candidate !== candidate || candidate.group !== group || group.proof) throw this.aborted();
    group.proof = proof; group.intervals = [];
    this.readyCandidate(output);
  }

  private checkGroupFloor(output: Output, chunk: SeekCmafChunk): void {
    const floor = output.candidate?.group?.floor;
    if (!floor) return;
    const ticks = chunk.timing?.earliestPtsTicks;
    if (ticks === undefined) { output.candidate!.group!.failed = true; throw new Error('Target sample floor facts are unavailable'); }
    const start = this.nativeTicks(output, ticks);
    if (start.numerator * floor.denominator < floor.numerator * start.denominator) {
      output.candidate!.group!.failed = true; throw new Error('Target sample precedes the retained native floor');
    }
  }

  tick(): void { if (!this.current()) this.cancel(); else this.output?.tick(); }
  setPlaying(playing: boolean): void { this.playing = playing; this.output?.setPlaying(playing); }
  sample(): MediaSeekSample | null { return this.current() ? this.native?.sample() ?? null : null; }
  cancel(): void { this.close(Object.assign(new Error('Seek playback retired'), { name: 'AbortError' })); }

  private current(): boolean { return !this.closed && this.options.isCurrent() && !this.closed; }
  private assertCurrent(): void { if (!this.current()) throw this.aborted(); }
  private aborted(): Error { return Object.assign(new Error('Seek page retired'), { name: 'AbortError' }); }
  private pageCurrent(output: Output, page: Page): boolean {
    return this.outputCurrent(output) && output.page === page && !page.failed;
  }
  private assertPage(output: Output, page: Page): void {
    if (!this.pageCurrent(output, page)) throw this.aborted();
  }

  private maybeAdopt(): void {
    if (this.output || this.adopting || ![...this.outputs.values()].every(output =>
      output.page?.accepted && !output.page.failed && output.prepared && output.covered)) return;
    this.adopting = true;
    try { this.adopt(); }
    catch (error) { this.fail(error); throw error; }
    for (const output of this.outputs.values()) if (output.page) void this.progress(output, output.page);
  }

  private async receive(output: Output, page: Page, object: MoqtObject, input?: object): Promise<void> {
    let retained = false;
    try {
      this.assertPage(output, page);
      if (page.fin) throw this.aborted();
      const bytes = object.kind === 'data' ? object.payload.length : 0;
      // Pre-OK data must not advance the retained consumer. Copy it while
      // releasing the sender, bounded by the existing preparation limits.
      if (page.early.length >= this.options.maxObjects || bytes > this.options.maxBytes - page.earlyBytes
          || (!this.output || !this.installed(output)) && (output.preparationObjects >= this.options.maxObjects
            || bytes > this.options.maxBytes - output.preparationBytes)) throw new Error('Seek early media exceeds preparation budget');
      page.early.push({ object: object.kind === 'data' ? { ...object, payload: object.payload.slice() } : { ...object }, input });
      page.earlyBytes += bytes; retained = true;
      if (!this.output || !this.installed(output)) { output.preparationObjects++; output.preparationBytes += bytes; }
      if (page.accepted) await this.wait(page, this.progress(output, page));
    } catch (error) {
      if (!retained && input !== undefined) this.discardInputs([input], 'epoch refused');
      if (this.pageCurrent(output, page)) this.failPage(output, page, error);
      throw error;
    }
  }

  private wait(page: Page, work: Promise<void>): Promise<void> {
    return this.waitSignal(page.cancellation.signal, work);
  }

  private waitSignal(signal: AbortSignal, work: Promise<void>): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    // Remove each listener on settlement; racing every Object against one
    // pending lifetime Promise would retain one reaction per Object.
    return new Promise<void>((resolve, reject) => {
      const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
      signal.addEventListener('abort', cancel, { once: true });
      void work.then(() => { signal.removeEventListener('abort', cancel); resolve(); }, error => {
        signal.removeEventListener('abort', cancel); reject(error);
      });
    });
  }

  private progress(output: Output, page: Page): Promise<void> {
    if (page.work) return page.work;
    const work = Promise.resolve().then(async () => {
      this.assertPage(output, page);
      while (page.early.length) {
        const early = page.early[0]!;
        let chunks: SeekCmafChunk[] = [], queued = 0;
        try {
          chunks = await this.pushInput(output, early.object, early.input, () => this.assertPage(output, page), () => {
            if (page.early[0] !== early) throw this.aborted();
            page.early.shift(); page.earlyBytes -= early.object.kind === 'data' ? early.object.payload.length : 0;
          });
          this.assertPage(output, page);
          output.prepared = output.input.ready;
          for (const chunk of chunks) {
            this.noteBoundary(output, chunk);
            this.noteGroup(output, chunk);
            output.covered ||= output.candidate?.options.readiness === 'indexed-boundary' || output.candidate?.options.readiness === 'indexed-group'
              ? output.candidate.indexedSample !== null : this.coverage(output, chunk.bytes, false).coversTarget;
            if (output.queued.length >= this.options.maxObjects || chunk.bytes.length > this.options.maxBytes - output.queuedBytes) {
              this.processingFailure(output);
              throw new Error('Seek queued media exceeds preparation budget');
            }
            output.queued.push(chunk); output.queuedBytes += chunk.bytes.length; queued++;
          }
          this.pruneWork(output);
        } catch (error) {
          for (const chunk of chunks.slice(queued)) this.discardInputs(chunk.inputs, this.current() ? 'invalid media' : 'decoder reset');
          throw error;
        }
        this.readyCandidate(output);
        this.maybeAdopt();
        if (output.candidate?.usable && !output.candidate.promoted) await this.waitSignal(output.lifetime.signal, output.candidate.promotion.promise);
        if (this.output && this.installed(output)) await this.drain(output, () => this.assertPage(output, page), () => page.failed);
        this.assertPage(output, page);
      }
      this.maybeAdopt();
      const candidate = output.candidate, group = candidate?.group;
      if (group && !candidate!.promoted && page.fin) {
        const through = page.receipt!.through, target = candidate!.options.location.groupId;
        if (through.groupId > target || through.groupId === target && through.kind === 'after-group' || page.endOfTrack) {
          this.closeGroup(output, page.endOfTrack ? 'track-end' : 'range-fin');
          await this.waitSignal(output.lifetime.signal, candidate!.promotion.promise); this.assertPage(output, page);
        }
      }
      if (this.output && this.installed(output)) await this.drain(output, () => this.assertPage(output, page), () => page.failed);
      this.assertPage(output, page);
      if (!group && page.fin && (!this.output || !this.installed(output)) && (!output.prepared || !output.covered)) {
        throw new Error(`Seek ${output.track.role} page ended before target coverage`);
      }
    });
    page.work = work;
    void work.then(() => {
      if (page.work === work) page.work = null;
      if (this.pageCurrent(output, page)) {
        if (page.early.length || this.output && output.queued.length && (!output.candidate?.group || this.installed(output))) void this.progress(output, page);
        else this.completePage(output, page);
      }
    }, error => {
      if (page.work === work) page.work = null;
      if (this.pageCurrent(output, page)) this.failPage(output, page, error);
    }).catch(error => { if (this.pageCurrent(output, page)) this.failPage(output, page, error); });
    return work;
  }

  private async drain(output: Output, assertOwner: () => void, retired: () => boolean, keepAccepted = false): Promise<void> {
    await this.prepared;
    assertOwner();
    while (output.queued.length) {
      await this.admitted(output, assertOwner);
      const hold = output.hold;
      if (hold?.cut?.credit) {
        this.output!.clearPreparationReadCredit(output.track.role, hold);
        await this.admitted(output, assertOwner);
      }
      const chunk = output.queued.shift()!;
      output.queuedBytes -= chunk.bytes.length;
      const emissions: SeekCmafChunk[] = [];
      this.active = { output, assertOwner, chunks: emissions, inputs: chunk.inputs };
      try {
        try {
          this.checkGroupFloor(output, chunk);
          this.assembler!.push(output.track.role, output.track.name, chunk.groupId, chunk.bytes,
            undefined, undefined, output.track.sourceKey, chunk.objectId);
          if (!emissions.length) throw new Error('Seek assembler refused complete media');
        } catch (error) { this.processingFailure(output); throw error; }
        assertOwner();
      } catch (error) {
        this.discardInputs(chunk.inputs, !this.current() ? 'decoder reset' : output.candidate?.group?.failed ? 'epoch refused' : 'invalid media'); throw error;
      } finally { this.active = null; }
      output.work.batchBytes = emissions.reduce((sum, emission) => sum + emission.bytes.length, 0);
      output.work.batchCut = null;
      this.prepareCredit(output);
      for (const emission of emissions) {
        let observation: CmafAppendObservation | undefined;
        let accepted = false, submitted = false;
        try {
          let coverage: ReturnType<MseSeekPlayback['coverage']>;
          try { coverage = this.coverage(output, emission.bytes, true); }
          catch (error) { this.processingFailure(output); throw error; }
          observation = this.options.observeAppend?.(emission.inputs);
          await this.admitted(output, assertOwner);
          this.prepareCredit(output);
          output.submitting = true;
          let work: Promise<void>;
          try {
            const native = this.native!, sink = this.output!, assembler = this.assembler, placement = output.placement;
            let offset: number | undefined;
            try { offset = native.getTimestampOffset(output.track.role); }
            catch (error) { this.processingFailure(output); throw error; }
            const offsetUs = nativeTimeUs(offset);
            assertOwner();
            if (!placement || typeof offset !== 'number' || !offsetUs || this.native !== native || this.output !== sink || this.assembler !== assembler
                || output.offset !== null && !Object.is(output.offset, offset)) {
              this.processingFailure(output); throw new Error('Seek native submission context changed');
            }
            output.offset = offset;
            const scale = BigInt(output.input.context.timescale);
            const floor = output.candidate?.group?.floor;
            if (floor) {
              if (coverage.minPresentationTicks === undefined) { output.candidate!.group!.failed = true; throw new Error('Target emission floor facts are unavailable'); }
              const start = this.nativeTicks(output, coverage.minPresentationTicks, true, offsetUs);
              if (start.numerator * floor.denominator < floor.numerator * start.denominator) {
                output.candidate!.group!.failed = true; throw new Error('Target emitted sample precedes the retained native floor');
              }
            }
            const endUs = { numerator: coverage.maxPresentationEndTicks * 1000000n * offsetUs.denominator + offsetUs.numerator * scale,
              denominator: scale * offsetUs.denominator };
            try {
              work = sink.append(output.track.role, emission.bytes, output.track.name,
                emission.groupId, output.track.sourceKey, coverage, observation?.token, { endUs, timestampOffset: offset,
                  admitted: () => !this.closed && !output.retired && this.outputs.get(output.track.role) === output
                    && this.native === native && this.output === sink && this.assembler === assembler && output.placement === placement
                    && Object.is(output.offset, offset) });
            } catch (error) { this.processingFailure(output); throw error; }
            work = work.catch(error => { this.processingFailure(output); throw error; });
            submitted = true;
          } finally {
            output.submitting = false;
            if (output.hold) this.installHold(output, output.hold);
          }
          await this.waitSignal(output.lifetime.signal, work);
          accepted = true;
          assertOwner();
        } catch (error) {
          if (keepAccepted && accepted || output.nativeRetired && submitted) throw error;
          if (observation) observation.discard(!this.current() ? 'decoder reset' : retired() ? 'append aborted' : 'append error');
          else this.discardInputs(emission.inputs, !this.current() ? 'decoder reset' : retired() ? 'epoch refused' : 'invalid media');
          throw error;
        }
      }
      output.work.batchBytes = 0; output.work.batchCut = null;
    }
    this.pruneWork(output);
  }

  private liveCurrent(output: Output, live: Live): boolean {
    return this.outputCurrent(output) && output.live === live && (live.state === 'open' || live.state === 'ending');
  }

  private assertLive(output: Output, live: Live, item?: LiveItem): void {
    if (!this.liveCurrent(output, live) || item?.admitted?.() === false || !this.liveCurrent(output, live)) throw this.aborted();
  }

  private receiveLive(output: Output, live: Live, object: MoqtObject, input?: object, admitted?: () => boolean): Promise<void> {
    let retained = false;
    try {
      this.assertLive(output, live);
      if (live.state !== 'open' || admitted?.() === false) throw this.aborted();
      this.assertLive(output, live);
      const bytes = object.kind === 'data' ? object.payload.length : 0;
      if (live.retainedObjects >= this.options.maxObjects || bytes > this.options.maxBytes - live.retainedBytes) {
        const error = new Error('Seek live input exceeds processing budget');
        this.stopLive(output, live, error, 'failed');
        throw error;
      }
      const snapshot = object.kind === 'data' ? { ...object, payload: object.payload.slice() } : { ...object };
      const promise = new Promise<void>((resolve, reject) => {
        live.queued.push({ object: snapshot, input, admitted, bytes, resolve, reject, inputOwned: false });
      });
      live.retainedObjects++; live.retainedBytes += bytes; retained = true;
      this.pumpLive(output, live);
      return promise;
    } catch (error) {
      if (!retained && input !== undefined) this.discardInputs([input], 'epoch refused');
      return Promise.reject(error);
    }
  }

  private pumpLive(output: Output, live: Live): void {
    if (live.work) return;
    const work = Promise.resolve().then(async () => {
      if (!this.liveCurrent(output, live)) { this.stopLive(output, live, this.aborted(), 'cancelled'); return; }
      while (this.liveCurrent(output, live) && live.queued.length) {
        const item = live.queued.shift()!;
        live.active = item;
        let chunks: SeekCmafChunk[] = [], queued = 0;
        try {
          chunks = await this.pushInput(output, item.object, item.input, () => this.assertLive(output, live, item), () => {
            item.inputOwned = true; // The format consumer owns diagnostic outcomes from here.
          });
          this.assertLive(output, live, item);
          for (const chunk of chunks) {
            if (output.queued.length >= this.options.maxObjects || chunk.bytes.length > this.options.maxBytes - output.queuedBytes) {
              this.processingFailure(output);
              throw new Error('Seek queued media exceeds preparation budget');
            }
            output.queued.push(chunk); output.queuedBytes += chunk.bytes.length; queued++;
          }
          await this.drain(output, () => this.assertLive(output, live, item), () => !this.liveCurrent(output, live), true);
          this.assertLive(output, live, item);
          item.resolve();
        } catch (error) {
          for (const chunk of chunks.slice(queued)) this.discardInputs(chunk.inputs, 'epoch refused');
          this.discardLiveInput(item, 'epoch refused');
          item.reject(error);
          this.stopLive(output, live, error instanceof Error ? error : new Error(String(error)), 'failed');
        } finally {
          live.retainedObjects--; live.retainedBytes -= item.bytes;
          if (live.active === item) live.active = null;
        }
      }
      if (this.liveCurrent(output, live) && live.state === 'ending') {
        await this.admitted(output, () => this.assertLive(output, live));
        this.assertLive(output, live);
        output.input.end();
        this.assertLive(output, live);
        this.output!.end(output.track.role);
        this.assertLive(output, live);
        output.ended = true; live.state = 'ended'; live.end!.resolve();
      }
    });
    live.work = work;
    void work.then(() => {
      if (live.work === work) live.work = null;
      if (this.liveCurrent(output, live)) {
        if (live.queued.length || live.state === 'ending') this.pumpLive(output, live);
      } else this.stopLive(output, live, this.aborted(), 'cancelled');
    }, error => {
      if (live.work === work) live.work = null;
      this.stopLive(output, live, error instanceof Error ? error : new Error(String(error)), 'failed');
    });
  }

  private endLive(output: Output, live: Live): Promise<void> {
    if (live.end) return live.end.promise;
    try { this.assertLive(output, live); }
    catch (error) { return Promise.reject(error); }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    live.end = { promise, resolve, reject }; live.state = 'ending';
    this.pumpLive(output, live);
    return promise;
  }

  private discardLiveInput(item: LiveItem, reason: 'epoch refused' | 'decoder reset'): void {
    if (item.inputOwned) return;
    item.inputOwned = true;
    if (item.input !== undefined) this.discardInputs([item.input], reason);
  }

  private stopLive(output: Output, live: Live, error: Error, state: 'cancelled' | 'failed', reason: 'epoch refused' | 'decoder reset' = 'epoch refused'): void {
    if (live.state === 'cancelled' || live.state === 'failed' || live.state === 'ended') return;
    live.state = state;
    const queued = live.queued.splice(0), chunks = output.queued.splice(0);
    output.queuedBytes = 0;
    for (const item of queued) { live.retainedObjects--; live.retainedBytes -= item.bytes; item.reject(error); }
    live.active?.reject(error); live.end?.reject(error);
    // Unstarted ownership ends now. Accepted native work keeps its real
    // terminal owner and budget charge until the active operation settles.
    for (const item of queued) this.discardLiveInput(item, reason);
    if (live.active) this.discardLiveInput(live.active, reason);
    for (const chunk of chunks) this.discardInputs(chunk.inputs, reason);
  }

  private completePage(output: Output, page: Page): void {
    const candidate = output.candidate, group = candidate?.group;
    if (group && !candidate!.promoted) {
      if (!page.accepted || !page.fin || page.early.length || group.proof || page.endOfTrack || this.blocked(output)) return;
      group.next = page.receipt!.through; output.page = null;
      this.observeError(() => candidate!.options.onPageDrained(page.identity, 'prepared'));
      return;
    }
    if (!page.accepted || !page.fin || !this.output || !this.installed(output) || this.blocked(output) || page.early.length || output.queued.length) return;
    try {
      if (page.endOfTrack) {
        output.input.end();
        this.assertPage(output, page);
        this.output.end(output.track.role);
        this.assertPage(output, page);
        output.ended = true;
      }
    } catch (error) { if (this.pageCurrent(output, page)) this.failPage(output, page, error); return; }
    output.page = null; // Finalize before callbacks may open the successor.
    try { void Promise.resolve(output.candidate ? group ? output.candidate.options.onPageDrained(page.identity, 'native') : output.candidate.options.onPageDrained(page.identity)
      : this.options.onPageDrained(output.track.role, page.identity)).catch(() => {}); }
    catch (error) { if (this.current() && output.page === null) this.fail(error); }
  }

  private adopt(): void {
    this.assertCurrent();
    const steadySegment = this.options.onSegment;
    const steadyDiscontinuity = this.options.onDiscontinuity ?? (() => {});
    const bridge: Pick<AssemblyCallbacks, 'onSegment'> & { onDiscontinuity: NonNullable<AssemblyCallbacks['onDiscontinuity']> } = {
      onSegment: (role, bytes, name, groupId, inputs, sourceKey) => {
        const active = this.active;
        if (!active) {
          if (!this.resourcesTransferred) throw new Error('Seek assembler emitted before output ownership');
          steadySegment(role, bytes, name, groupId, inputs, sourceKey); return;
        }
        if (role !== active.output.track.role || name !== active.output.track.name
            || sourceKey !== active.output.track.sourceKey) throw new Error('Seek assembler emitted without its input identity');
        active.assertOwner();
        active.chunks.push({ bytes, groupId, objectId: 0n,
          ...(active.inputs ? { inputs: active.inputs } : {}) });
      },
      onDiscontinuity: (...args) => {
        if (this.active) throw new Error('Seek media changed its presentation timeline');
        if (this.resourcesTransferred) steadyDiscontinuity(...args);
      },
    };
    // The factory callbacks retain only this small bridge. Retirement severs
    // its reference to the FETCH consumer while adopted output stays usable.
    this.releaseAssemblyBridge = transferred => {
      bridge.onSegment = transferred ? steadySegment : () => {};
      bridge.onDiscontinuity = transferred ? steadyDiscontinuity : () => {};
    };
    const assembler = this.options.createAssembler({
      onSegment: (...args) => bridge.onSegment(...args),
      onDiscontinuity: (...args) => bridge.onDiscontinuity(...args),
      ...(this.options.onDiscard ? { onDiscard: this.options.onDiscard } : {}),
    });
    // An injected factory must never let preparation mutate/destroy the live assembler.
    if (assembler === this.options.liveAssembler) throw new Error('Seek factory returned the live assembler');
    // A factory may retire the actor before handing back its new allocation.
    // close() could not release a handle it had not acquired yet.
    if (this.closed) { assembler.destroy(); this.assertCurrent(); }
    this.assembler = assembler;
    this.assertCurrent();
    if (assembler.supportsTrackIdentity !== true || !assembler.selectTrack || !assembler.setInitSegment
        || !assembler.setPresentationPlacement) throw new Error('Seek assembler lacks identity or presentation placement');
    for (const output of this.outputs.values()) {
      this.assertCurrent(); assembler.selectTrack(output.track.role, output.track.name, output.track.sourceKey);
      this.assertCurrent(); assembler.setInitSegment(output.track.role, output.track.init);
      output.placement = freezePlacement(output.input.anchor!);
      this.assertCurrent(); assembler.setPresentationPlacement(output.track.role, output.placement);
    }
    this.assertCurrent();
    this.options.beforeResourceChange();
    this.assertCurrent();
    const resource = this.options.source.beginSeek!(this.options.epoch);
    // Reject an unrelated returned handle before treating it as ours to cancel.
    if (resource.epoch !== this.options.epoch) throw new Error('Media adapter returned an unrelated seek resource');
    if (this.closed) { resource.cancel(); this.assertCurrent(); }
    this.native = resource;
    this.assertCurrent();
    if (!resource.current) throw new Error('Media adapter returned a retired seek resource');
    this.resourcesTransferred = true;
    this.options.adopt(Object.freeze({ resource, assembler }));
    this.assertCurrent();
    const output = new MseSeekOutput({ resource, targetMs: this.options.targetMs, roles: [...this.outputs.keys()],
      playing: this.playing, isCurrent: () => this.current(), onPosition: sample => {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.options.onPosition(sample);
      },
      retire: () => { if (!this.resourcesTransferred) resource.cancel(); },
      ...(this.options.onSubmitted ? { onSubmitted: this.options.onSubmitted } : {}),
      onError: error => this.fail(error) });
    this.output = output;
    this.assertCurrent();
    const config: Parameters<MediaSourceLike['initialize']>[0] = {};
    for (const { track } of this.outputs.values()) config[track.role] = { codec: track.codec, initData: track.init };
    if (resource.initialize(config) === false) throw new Error('Seek initialization was refused');
    this.assertCurrent();
    // initialize() may precede native sourceopen. The owned waiter avoids
    // submitting accepted FETCH media into the adapter's pre-attachment drop path.
    void resource.whenAttached().then(() => {
      this.assertCurrent();
      this.preparedResolve();
    }).catch(error => this.fail(error));
  }

  private finish(output: Output, page: Page, terminal: DataStreamTerminal): void {
    if (!this.pageCurrent(output, page)) return;
    // FIN can precede the response. A later refusal still owns this page.
    if (terminal !== 'fin') { this.failPage(output, page, new Error(`Seek FETCH ended with ${terminal}`)); return; }
    if (page.fin) return;
    page.fin = true;
    if (page.accepted) void this.progress(output, page);
  }

  private failPage(output: Output, page: Page, reason: unknown): void {
    if (!this.pageCurrent(output, page)) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const candidate = output.candidate;
    if (candidate && !candidate.promoted) {
      this.cancelCandidate(output, error);
      if (this.current() && this.candidateAdmitted(candidate)) this.observeError(() => candidate.options.onPageError(page.identity, error));
      return;
    }
    // Losing parsed chunks after promotion breaks this consumer's retained
    // decode history, even when the request itself failed lawfully. Latch
    // before abort or discard observers can reenter.
    if (candidate?.promoted && output.queued.length !== 0) candidate.processingFailed = true;
    page.failed = true;
    page.cancellation.abort(error);
    const early = page.early.splice(0), queued = output.queued.splice(0);
    page.earlyBytes = 0; output.queuedBytes = 0;
    const hold = output.hold;
    if (hold?.cut) {
      hold.cut.reached.reject(error); hold.native.reject(error);
      this.resumeHold(output, hold);
    }
    for (const item of early) if (item.input !== undefined) this.discardInputs([item.input], 'epoch refused');
    for (const chunk of queued) this.discardInputs(chunk.inputs, 'epoch refused');
    if (this.closed) return;
    // Before transfer there is no accepted native output to preserve. The
    // engine receives the page failure and owns cancelling all its requests.
    if (!this.resourcesTransferred) this.close(error);
    // Disposal observers can revoke admission without calling cancel(). A
    // deliberate candidate close still permits reporting to its current owner.
    if (!this.options.isCurrent()) return;
    try { void Promise.resolve(candidate ? candidate.options.onPageError(page.identity, error) : this.options.onPageError(output.track.role, page.identity, error)).catch(() => {}); }
    catch { /* A page observer cannot invalidate another request's ownership. */ }
  }

  private fail(reason: unknown): void {
    if (this.closed) return;
    const report = this.current(), error = reason instanceof Error ? reason : new Error(String(reason));
    this.close(error);
    if (report && this.options.isCurrent()) this.options.onError(error);
  }

  private discardInputs(inputs: SeekCmafChunk['inputs'], reason: 'invalid media' | 'decoder reset' | 'epoch refused'): void {
    if (!inputs || !this.options.onDiscard) return;
    for (const input of inputs) if (input !== undefined) {
      try { void Promise.resolve(this.options.onDiscard(input, reason)).catch(() => {}); }
      catch { /* Optional evidence cannot interrupt input retirement. */ }
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.preparedReject(error);
    const bindings = new Set([...this.outputs.values(), ...this.candidates.values()]);
    this.candidates.clear();
    for (const output of bindings) this.retireOutput(output, error, 'decoder reset');
    const releaseBridge = this.releaseAssemblyBridge; this.releaseAssemblyBridge = null;
    releaseBridge?.(this.resourcesTransferred);
    const output = this.output, native = this.native, assembler = this.assembler;
    this.output = null; this.native = null; this.assembler = null;
    try { if (output) output.cancel(); else if (!this.resourcesTransferred) native?.cancel(); }
    finally { if (!this.resourcesTransferred) assembler?.destroy(); }
  }
}
