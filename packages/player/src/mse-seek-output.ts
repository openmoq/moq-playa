import type { MediaAppendObservation, MediaSeekResource, MediaSeekSample } from './interfaces.js';
import type { FractionUs } from './presentation-placement.js';

type Role = 'video' | 'audio';
export interface MseSeekSubmissionFrontier {
  readonly revision: object;
  readonly highestSubmittedGroup: bigint | null;
  readonly maxSubmittedEndUs: FractionUs | null;
}
interface Submission {
  readonly endUs: FractionUs;
  readonly timestampOffset: number;
  /** Pure actor identity check; all callback-bearing admission precedes reservation. */
  readonly admitted: () => boolean;
}
function emptyFrontier(): MseSeekSubmissionFrontier {
  return Object.freeze({ revision: {}, highestSubmittedGroup: null, maxSubmittedEndUs: null });
}
interface PendingAppend {
  readonly token: object;
  readonly endTimeSeconds: number;
  readonly coversTarget: boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  appended: boolean;
}
interface RoleState {
  frontier: MseSeekSubmissionFrontier;
  covered: boolean;
  preCoverageBytes: number;
  ended: boolean;
  pending: PendingAppend | null;
  suspension: Suspension | null;
  preparationCredit: { readonly owner: object; readonly admitted: () => boolean } | null;
}
interface Suspension {
  readonly pending: PendingAppend | null;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  nativeReady: boolean;
}
/** Queue ownership for one positioned role; native completion is independent of read credit. */
export interface MseSeekRoleSuspension {
  readonly current: boolean;
  readonly nativeSettled: Promise<void>;
  /** Restore the original role and its pending credit. Abandon an unsettled lease barrier. */
  resume(): void;
  /** Caller proves prepared target readiness. Requires native settlement; retires only old role credit. */
  commit(): void;
}
interface Options {
  readonly resource: MediaSeekResource;
  readonly targetMs: number;
  readonly roles: readonly Role[];
  readonly playing: boolean;
  /** Admission identity, independent of the native resource being retired during cleanup. */
  readonly isCurrent: () => boolean;
  readonly onPosition: (sample: MediaSeekSample) => void;
  /** Resource retirement belongs to its owner; invoked once after local waits/listeners are released. */
  readonly retire: () => void;
  readonly onError: (error: Error) => void;
  readonly onSubmitted?: (role: Role) => void;
}

/** Native completion and read credit for one seek; media parsing belongs to its input owner. */
export class MseSeekOutput {
  // Application lookahead policy, enforced by pausing FETCH reads, never by dropping media.
  private static readonly LOOKAHEAD_SECONDS = 5;
  private static readonly PRE_COVERAGE_BYTES = 8 * 1024 * 1024;
  private readonly roles = new Map<Role, RoleState>();
  private release: (() => void) | null = null;
  private closed = false;
  private positioning = false;
  private positioned = false;
  private playing: boolean;

  constructor(private readonly options: Options) {
    if (!Number.isFinite(options.targetMs) || options.targetMs < 0) throw new RangeError('Invalid seek position');
    if (!options.roles.length || options.roles.some(role => role !== 'video' && role !== 'audio')
        || new Set(options.roles).size !== options.roles.length) throw new Error('Expected distinct selected media roles');
    for (const role of options.roles) this.roles.set(role, { frontier: emptyFrontier(), covered: false, preCoverageBytes: 0, ended: false, pending: null, suspension: null, preparationCredit: null });
    this.playing = options.playing;
    let release: (() => void) | null = null;
    try {
      release = options.resource.observeAppends(observation => this.observe(observation));
      if (!this.current()) throw this.aborted();
      this.release = release;
    } catch (error) { release?.(); throw error; }
  }

  /** One outstanding input per FETCH; callers must await credit before reading its next Object. */
  append(role: Role, bytes: Uint8Array, name: string, group: bigint, sourceKey: string,
      evidence: { readonly endTimeSeconds: number; readonly coversTarget: boolean }, token?: object, submission?: Submission): Promise<void> {
    if (!this.current()) { this.cancel(); return Promise.reject(this.aborted()); }
    const state = this.roles.get(role);
    if (state?.suspension) return Promise.reject(new Error('Seek media role is suspended'));
    if (!state || state.ended) return Promise.reject(new Error('Seek media role has ended or was not selected'));
    if (state.pending !== null) return Promise.reject(new Error('Concurrent seek input is already pending'));
    if (!Number.isFinite(evidence.endTimeSeconds) || evidence.endTimeSeconds < 0) {
      return Promise.reject(new Error('Seek append has no finite presentation end'));
    }
    return new Promise<void>((resolve, reject) => {
      // Context access can reenter role suspension/promotion. Refuse before
      // registering work unless the captured actor and native offset still agree.
      if (submission) {
        try {
          if (!this.current()) { this.cancel(); reject(this.aborted()); return; }
          const offset = this.options.resource.getTimestampOffset(role);
          if (!this.current()) { this.cancel(); reject(this.aborted()); return; }
          const admitted = submission.admitted();
          if (!admitted || this.closed || this.roles.get(role) !== state || state.suspension || state.ended || state.pending) {
            reject(this.aborted()); return;
          }
          if (!Number.isFinite(submission.timestampOffset) || !Object.is(offset, submission.timestampOffset)
              || submission.endUs.denominator <= 0n) {
            reject(new Error('Seek native submission context changed')); return;
          }
        } catch (error) { reject(error); return; }
      }
      if (!state.covered && !evidence.coversTarget) {
        if (bytes.length > MseSeekOutput.PRE_COVERAGE_BYTES - state.preCoverageBytes) {
          const error = new Error('Seek media before target coverage exceeds byte budget');
          this.fail(error); reject(error); return;
        }
        state.preCoverageBytes += bytes.length;
      }
      const pending: PendingAppend = { token: token ?? {}, ...evidence, resolve, reject, appended: false };
      state.pending = pending;
      if (submission) {
        const prior = state.frontier, end = prior.maxSubmittedEndUs, value = submission.endUs;
        state.frontier = Object.freeze({ revision: {},
          highestSubmittedGroup: prior.highestSubmittedGroup === null || group > prior.highestSubmittedGroup ? group : prior.highestSubmittedGroup,
          maxSubmittedEndUs: !end || value.numerator * end.denominator > end.numerator * value.denominator
            ? Object.freeze({ ...value }) : end });
      }
      try {
        this.options.resource.appendChunk(role, bytes, name, group, pending.token, sourceKey);
        // A native callback may synchronously replace the player's output.
        if (!this.current()) this.cancel();
        else if (this.roles.get(role) === state) this.options.onSubmitted?.(role);
      } catch (error) { this.fail(error); }
    });
  }

  /** Historical submission facts only; the actor separately checks current ownership. */
  submissionFrontier(role: Role): MseSeekSubmissionFrontier | null { return this.roles.get(role)?.frontier ?? null; }

  /** The actor has charged this cut's current batch; native success is still required. */
  enablePreparationReadCredit(role: Role, owner: object, admitted: () => boolean): void {
    if (!this.current()) { this.cancel(); return; }
    const state = this.roles.get(role);
    if (!state || state.ended || state.suspension) return;
    const allowed = admitted();
    if (!allowed || this.closed || this.roles.get(role) !== state || state.ended || state.suspension) return;
    if (state.preparationCredit && state.preparationCredit.owner !== owner) return;
    state.preparationCredit = { owner, admitted };
    this.tick();
  }

  clearPreparationReadCredit(role: Role, owner: object): void {
    const state = this.roles.get(role);
    if (!state || state.preparationCredit?.owner !== owner) return;
    state.preparationCredit = null;
    this.tick();
  }

  /** The input owner must also gate parsing/assembly before taking this native-output lease. */
  suspendRole(role: Role): MseSeekRoleSuspension {
    const state = this.roles.get(role);
    if (!state) throw new Error('Seek media role was not selected');
    if (!this.positioned) throw new Error('Seek output has not been positioned');
    if (state.suspension) throw new Error('Seek media role is already suspended');
    if (!this.current()) { this.cancel(); throw this.aborted(); }
    // Admission/resource access can synchronously replace the role or take another lease.
    if (this.roles.get(role) !== state || state.suspension) throw this.aborted();
    let resolve!: () => void, reject!: (error: Error) => void;
    const nativeSettled = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void nativeSettled.catch(() => {});
    const suspension: Suspension = { pending: state.pending, resolve, reject,
      nativeReady: state.pending === null || state.pending.appended };
    state.suspension = suspension;
    if (suspension.nativeReady) resolve();
    const output = this;
    return Object.freeze({
      get current() { return output.suspensionCurrent(role, state, suspension); },
      nativeSettled,
      resume: () => {
        if (!this.suspensionCurrent(role, state, suspension)) return;
        state.suspension = null;
        if (!suspension.nativeReady) reject(this.aborted());
        this.tick();
      },
      commit: () => {
        if (!this.suspensionCurrent(role, state, suspension)) throw this.aborted();
        if (!suspension.nativeReady || state.pending !== suspension.pending
            || state.pending !== null && !state.pending.appended) throw new Error('Seek native append has not settled');
        // Replace authority before settling old waits; neither old tokens nor
        // a consumed lease can mutate the new role. Shared positioning stays intact.
        state.suspension = null;
        const pending = state.pending; state.pending = null;
        // Coverage belongs to the positioned graph. A prepared replacement
        // must not cover the original seek point again to receive read credit.
        this.roles.set(role, { frontier: Object.freeze({ ...state.frontier, revision: {} }),
          covered: true, preCoverageBytes: 0, ended: false, pending: null, suspension: null, preparationCredit: null });
        pending?.reject(this.aborted());
      },
    });
  }

  private suspensionCurrent(role: Role, state: RoleState, suspension: Suspension): boolean {
    if (this.roles.get(role) !== state || state.suspension !== suspension) return false;
    if (!this.current()) { this.cancel(); return false; }
    return this.roles.get(role) === state && state.suspension === suspension;
  }

  /** Engine ticks release read credit only from the current resource's observed position. */
  tick(): void {
    if (!this.current()) { this.cancel(); return; }
    let head = this.options.targetMs / 1000;
    if (this.positioned) {
      let sample: MediaSeekSample | null;
      try { sample = this.options.resource.sample(); } catch (error) { this.fail(error); return; }
      if (!this.current()) { this.cancel(); return; }
      if (!this.validSample(sample)) return;
      head = sample.currentTime;
    }
    for (const [role, state] of this.roles) {
      const pending = state.pending;
      const permission = state.preparationCredit, preparation = permission?.admitted() === true;
      if (this.closed || this.roles.get(role) !== state || state.pending !== pending || state.preparationCredit !== permission) continue;
      // An uncovered role must reach another Object or EOF. Waiting for a
      // playhead that cannot be positioned yet would make that read circular.
      // Its native preparation is bounded separately by PRE_COVERAGE_BYTES.
      if (!state.suspension && pending?.appended && (preparation || !state.covered || pending.endTimeSeconds - head < MseSeekOutput.LOOKAHEAD_SECONDS)) {
        state.pending = null; pending.resolve();
      }
    }
  }

  end(role: Role): void {
    if (!this.current()) { this.cancel(); return; }
    const state = this.roles.get(role);
    if (state?.suspension) throw new Error('Seek media role is suspended');
    if (!state || state.ended) return;
    state.ended = true;
    if (!state.covered) this.fail(new Error(`Seek ${role} FETCH ended before target coverage`));
  }

  setPlaying(playing: boolean): void {
    if (!this.current()) { this.cancel(); return; }
    this.playing = playing;
    if (this.positioned) {
      try { this.options.resource.setPlaybackIntent(playing); } catch (error) { this.fail(error); }
    }
  }

  cancel(): void { this.close(this.aborted()); }

  private observe(observation: MediaAppendObservation): void {
    if (!this.current()) { this.cancel(); return; }
    for (const state of this.roles.values()) {
      const pending = state.pending;
      if (pending?.token !== observation.token || pending.appended) continue;
      if (observation.state !== 'appended') {
        this.fail(new Error(`Seek append ${observation.state}: ${observation.reason}`)); return;
      }
      pending.appended = true;
      state.covered ||= pending.coversTarget;
      if (state.covered) state.preCoverageBytes = 0;
      const suspension = state.suspension;
      if (suspension?.pending === pending) { suspension.nativeReady = true; suspension.resolve(); }
      this.maybePosition();
      this.tick();
      return;
    }
  }

  private maybePosition(): void {
    if (this.positioning || ![...this.roles.values()].every(state => state.covered)) return;
    this.positioning = true;
    let work: Promise<MediaSeekSample>;
    try { work = this.options.resource.position(this.options.targetMs / 1000); }
    catch (error) { this.fail(error); return; }
    void Promise.resolve(work).then(sample => {
      if (!this.current()) { this.cancel(); return; }
      if (!this.validSample(sample)) { this.fail(new Error('Seek returned an unrelated or unproven native position')); return; }
      if (!this.current()) { this.cancel(); return; }
      this.positioned = true;
      this.options.onPosition(sample);
      if (!this.current()) { this.cancel(); return; }
      this.options.resource.setPlaybackIntent(this.playing);
      this.tick();
    }).catch(error => this.fail(error));
  }

  private validSample(sample: MediaSeekSample | null): sample is MediaSeekSample {
    return sample !== null && sample.epoch === this.options.resource.epoch && sample.resource === this.options.resource.resource
      && Number.isFinite(sample.currentTime) && sample.currentTime >= 0
      && Number.isFinite(sample.buffered.start) && Number.isFinite(sample.buffered.end)
      && sample.buffered.start <= sample.currentTime && sample.currentTime <= sample.buffered.end;
  }

  private current(): boolean {
    try {
      return !this.closed && this.options.isCurrent() && !this.closed && this.options.resource.current
        && !this.closed && this.options.isCurrent() && !this.closed;
    } catch { return false; }
  }

  private fail(reason: unknown): void {
    if (this.closed) return;
    const report = this.current(), error = reason instanceof Error ? reason : new Error(String(reason));
    this.close(error);
    if (report && this.options.isCurrent()) this.options.onError(error);
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    // Detach and settle our waits before calling external resource cleanup.
    const release = this.release; this.release = null;
    const pending = [...this.roles.values()].flatMap(state => {
      state.preparationCredit = null;
      const suspension = state.suspension; state.suspension = null;
      suspension?.reject(error);
      const item = state.pending; state.pending = null; return item ? [item] : [];
    });
    for (const item of pending) item.reject(error);
    try { release?.(); } finally { this.options.retire(); }
  }

  private aborted(): Error { return Object.assign(new Error('Seek output retired'), { name: 'AbortError' }); }
}
