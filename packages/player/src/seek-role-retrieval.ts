import type { MoqtObject, ObjectDatagram, TrackPropertyValue } from '@openmoq/transport';
import type { FetchReceiver, MoqtConnection } from '@openmoq/webtransport';
import type { TimelineState } from './timeline-manager.js';
import type { SeekGroupPageAcceptance, SeekInputReceiver, SeekLiveInput } from './seek-retrieval-contracts.js';
import { SeekFetchRequests, type SeekFetchResponse } from './seek-fetch-requests.js';
import { SeekLiveBridge } from './seek-live-bridge.js';
import { advanceSeekFetchCut, planSeekFetchPage, seekCutAfterLocation, type SeekFetchCut, type SeekFetchPageProof } from './seek-fetch-pages.js';

/** Request identity only; codec, packaging and output preparation belong to the consumer. */
export interface SeekRetrievalTrack {
  readonly role: 'video' | 'audio';
  readonly name: string;
  readonly namespace: readonly string[];
}

interface Page {
  readonly identity: object;
  readonly receiver: SeekInputReceiver;
  readonly transport: FetchReceiver | null;
  readonly proof: SeekFetchPageProof | undefined;
  accepted: { cut: SeekFetchCut; advanced: boolean; endOfTrack: boolean } | null;
  cancel: (() => void) | null;
}

export interface SeekRoleBridgeOwner {
  readonly track: SeekRetrievalTrack;
  readonly role: SeekRetrievalTrack['role'];
  bridge: SeekLiveBridge | null;
  input: SeekLiveInput | null;
  accepted: boolean;
  ending: boolean;
  drained: (() => void) | null;
  readonly cancel: () => void;
}

interface Options {
  readonly connection: MoqtConnection;
  readonly track: SeekRetrievalTrack;
  readonly location: { readonly groupId: bigint; readonly objectId: bigint };
  readonly timeoutMs: number;
  readonly maxObjects: number;
  readonly maxBytes: number;
  readonly isCurrent: () => boolean;
  readonly getTimeline: () => TimelineState | null;
  /** Non-null only while this consumer prepares a complete indexed group. */
  readonly getPreparingGroup?: () => bigint | null;
  readonly canProbeLive: () => boolean;
  readonly admitHead: () => boolean;
  readonly beforeSubscribe: () => boolean;
  readonly beginPage: (identity: object) => SeekInputReceiver;
  readonly acceptPage: (identity: object, endOfTrack: boolean, receipt?: SeekGroupPageAcceptance) => void;
  readonly beginLive: (owner: object, liveTrackProperties: ReadonlyMap<bigint, readonly TrackPropertyValue[]>) => SeekLiveInput;
  readonly capture: (object: MoqtObject | ObjectDatagram) => object | undefined;
  readonly discard: (input: object | undefined) => void;
  readonly consume: (object: MoqtObject, captured: object | undefined, current: () => boolean,
    deliver: (object: MoqtObject, input?: object) => Promise<void>) => Promise<void>;
  readonly liveObservation?: (owner: SeekRoleBridgeOwner) => NonNullable<ConstructorParameters<typeof SeekLiveBridge>[1]['liveObservation']>;
  /** First FETCH registration, after authorization and before its bytes are sent. */
  readonly onFirstRequest?: () => void;
  readonly onBridgeAdded: (owner: SeekRoleBridgeOwner) => void;
  readonly onBridgeRemoved: (owner: SeekRoleBridgeOwner) => void;
  readonly onEnded: () => void;
  readonly onProgress: () => void;
  readonly onFailure: (error: Error, kind: 'page' | 'planning' | 'live', current: () => boolean) => void;
}

/** One media role's requests and ordered continuation; its output host owns parsing and native work. */
export class SeekRoleRetrieval {
  readonly requests: SeekFetchRequests;
  /** First owned SDK emission attempt; no FETCH_OK, range, FIN or native claim. */
  readonly firstIssued: Promise<bigint>;
  private resolveFirst!: (id: bigint) => void;
  private rejectFirst!: (error: Error) => void;
  private firstSettled = false;
  private firstReceiver: FetchReceiver | null = null;
  private readonly draft: 14 | 16 | 18 | 22;
  private cut: SeekFetchCut;
  private lastNonProgress: SeekFetchPageProof | undefined;
  private page: Page | null = null;
  private bridge: SeekRoleBridgeOwner | null = null;
  private first = true;
  private stopped = false;
  private ended = false;
  private retired = false;

  constructor(private readonly options: Options) {
    const draft = options.connection.draftVersion;
    if (draft !== 14 && draft !== 16 && draft !== 18 && draft !== 22) throw new Error('Cannot seek: historical page semantics are unavailable for this draft');
    this.firstIssued = new Promise<bigint>((resolve, reject) => { this.resolveFirst = resolve; this.rejectFirst = reject; });
    void this.firstIssued.catch(() => {});
    this.draft = draft;
    this.cut = { kind: 'before', ...options.location };
    this.requests = new SeekFetchRequests(options.connection, { isCurrent: () => this.current(),
      ...(options.onFirstRequest ? { onRegister: (receiver: FetchReceiver) => {
        if (receiver === this.firstReceiver) options.onFirstRequest!();
      } } : {}), onError: (error, receiver) => {
      if (receiver === this.firstReceiver) this.settleFirst(error);
      const page = this.page;
      if (page?.transport === receiver) this.failPage(page, error);
    } });
  }

  pump(): void {
    if (!this.current()) return;
    try { this.openPage(); }
    catch (error) {
      if (!this.current()) return;
      const page = this.page;
      const firstFailure = !this.firstSettled && (this.first
        || this.firstReceiver !== null && page?.transport === this.firstReceiver);
      const planning = page === null && !this.stopped;
      // Reserve the original outcome and reporting identity before arbitrary
      // conversion can cancel this role or attempt another pump.
      if (firstFailure) { this.firstSettled = true; this.firstReceiver = null; }
      if (planning) this.stopped = true;
      let cause: Error;
      try { cause = error instanceof Error ? error : new Error(String(error), { cause: error }); }
      catch { cause = new Error('Seek role retrieval failed', { cause: error }); }
      if (firstFailure) this.rejectFirst(cause);
      if (page) this.failPage(page, cause);
      else if (planning) this.options.onFailure(cause, 'planning', () => this.current());
    }
  }

  onPageDrained(identity: object): void {
    const page = this.page;
    if (!this.current() || !page || page.identity !== identity || !page.accepted) return;
    try {
      const advanced = page.accepted;
      this.cut = advanced.cut;
      this.lastNonProgress = advanced.advanced ? undefined : page.proof;
      this.page = null;
      if (advanced.endOfTrack) { this.ended = true; this.options.onEnded(); }
      this.bridge?.drained?.();
      queueMicrotask(() => { if (this.current()) { this.options.onProgress(); this.pump(); } });
    } catch (error) { this.failPage(page, error instanceof Error ? error : new Error(String(error))); }
  }

  onPageError(identity: object, error: Error): void {
    const page = this.page;
    if (page?.identity === identity) this.failPage(page, error);
  }

  cancel(): void {
    if (this.retired) return;
    this.retired = true;
    this.settleFirst(Object.assign(new Error('Seek role issuance retired'), { name: 'AbortError' }));
    this.bridge?.cancel();
    this.requests.dispose();
  }

  private settleFirst(result: Error | bigint): void {
    if (this.firstSettled) return;
    if (typeof result === 'bigint' && !this.current()) {
      result = Object.assign(new Error('Seek role issuance retired'), { name: 'AbortError' });
    }
    // The ownership callback above may synchronously cancel this service.
    if (this.firstSettled) return;
    this.firstSettled = true; this.firstReceiver = null;
    if (typeof result === 'bigint') this.resolveFirst(result); else this.rejectFirst(result);
  }

  private current(): boolean { return !this.retired && this.options.isCurrent() && !this.retired; }

  private failPage(page: Page, error: Error): void {
    if (!this.current() || this.page !== page) return;
    if (page.transport === this.firstReceiver) this.settleFirst(error);
    this.page = null; this.stopped = true;
    page.cancel?.(); page.receiver.onClosed('error');
    if (this.current()) this.options.onFailure(error, 'page', () => this.current());
  }

  private openPage(): void {
    if (!this.current() || this.page || this.stopped || this.ended) return;
    const timeline = this.options.getTimeline();
    if (!timeline || !this.current()) return;
    const preparingGroup = this.options.getPreparingGroup?.() ?? null;
    if (!this.current() || this.page || this.stopped || this.ended) return;
    const snapshot = preparingGroup === null && this.first && !timeline.isLive;
    const plan = snapshot ? null : planSeekFetchPage({ draftVersion: this.draft, trackName: this.options.track.name,
      timeline, cut: this.cut, endOfTrack: false, includeIndexedTip: this.first,
      ...(preparingGroup === null ? {} : { preparingGroup }),
      ...(this.lastNonProgress ? { lastNonProgress: this.lastNonProgress } : {}) });
    if (this.bridge) {
      // An unaccepted live probe must not hold up newly indexed history.
      if (this.bridge.accepted || plan?.kind !== 'fetch-page') return;
      this.bridge.cancel();
      if (!this.current()) return;
    }
    if (plan?.kind === 'probe-live') { this.openBridge(plan.proof); return; }
    if (plan && plan.kind !== 'fetch-page') return;
    const identity = {}, receiver = this.options.beginPage(identity);
    const transport: FetchReceiver = {
      onObject: async (object, receiving) => {
        const current = () => this.current() && !receiving.signal.aborted;
        if (!current()) return;
        const captured = this.options.capture(object);
        await this.options.consume(object, captured, current, (value, input) => receiver.onObject(value, input));
      },
      onClosed: terminal => receiver.onClosed(terminal),
    };
    const page: Page = { identity, receiver, transport, proof: plan?.proof, accepted: null, cancel: null };
    const start = this.first ? { groupId: this.options.location.groupId, objectId: 0n } : plan!.start;
    const first = this.first;
    this.page = page; this.first = false;
    const accept = (response: SeekFetchResponse) => {
      if (!this.current() || this.page !== page) return;
      page.accepted = advanceSeekFetchCut(this.draft, this.cut, response);
      this.options.acceptPage(identity, response.endOfTrack, Object.freeze({ start: Object.freeze({ ...start }),
        through: Object.freeze({ ...page.accepted.cut }), endOfTrack: response.endOfTrack, groupOrder: 'ascending', rangeFilters: false,
        ...(response.trackProperties ? { trackProperties: response.trackProperties } : {}) }));
    };
    let cancel: () => void;
    if (first) {
      this.firstReceiver = transport;
      const issuance = this.requests.openIssued(this.options.track, start, transport, accept, plan?.end);
      cancel = issuance.cancel;
      void issuance.issued.then(id => this.settleFirst(id), error => this.settleFirst(error instanceof Error ? error : new Error(String(error))));
    } else cancel = this.requests.open(this.options.track, start, transport, accept, plan?.end);
    if (!this.current() || this.page !== page) cancel(); else page.cancel = cancel;
  }

  private openBridge(proof: SeekFetchPageProof): void {
    const draft = this.draft;
    if (this.cut.kind !== 'before' || !this.options.canProbeLive() || !this.current()) return;
    const start = Object.freeze({ groupId: this.cut.groupId, objectId: this.cut.objectId });
    const track = this.options.track, abort = new AbortController();
    let retired = false, timer: ReturnType<typeof setTimeout> | null = null;
    const current = () => this.current() && !retired && this.bridge === owner && !this.stopped;
    const clearDeadline = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const cancel = () => {
      if (retired) return;
      retired = true; clearDeadline();
      if (this.bridge === owner) this.bridge = null;
      this.options.onBridgeRemoved(owner);
      abort.abort(); owner.bridge?.cancel(); owner.input?.cancel();
      const resolve = owner.drained; owner.drained = null; resolve?.();
    };
    const refused = (error?: Error): void => {
      if (!current()) return;
      const page = this.page;
      if (page) { this.failPage(page, error ?? new Error('Live catch-up was declined')); return; }
      if (owner.accepted) this.stopped = true;
      this.lastNonProgress = proof; cancel();
      if (error && this.current()) this.options.onFailure(error, 'live', () => this.current());
      queueMicrotask(() => { if (this.current()) this.pump(); });
    };
    const armDeadline = () => {
      clearDeadline();
      if (current()) timer = setTimeout(() => refused(new Error('Live catch-up peer wait timed out')), this.options.timeoutMs);
    };
    const owner: SeekRoleBridgeOwner = { track, role: track.role, bridge: null, input: null, accepted: false, ending: false, drained: null, cancel };
    this.bridge = owner; this.options.onBridgeAdded(owner);
    try {
      if (!this.options.beforeSubscribe()) { refused(); return; }
      if (!current()) { cancel(); return; }
      const bridge = new SeekLiveBridge(this.options.connection, {
        track, start,
        maxObjects: this.options.maxObjects, maxBytes: this.options.maxBytes, isCurrent: current, signal: abort.signal,
        admitHead: async () => current() && this.options.admitHead(),
        capture: this.options.capture, onDiscard: this.options.discard,
        ...(this.options.liveObservation ? { liveObservation: this.options.liveObservation(owner) } : {}),
        consumePrefix: async (object, input, admitted) => {
          clearDeadline();
          const page = this.page;
          if (!page || !current()) { this.options.discard(input); return; }
          try { await this.options.consume(object, input, () => current() && admitted(),
            (value, context) => page.receiver.onObject(value, context)); }
          finally { armDeadline(); }
        },
        consumeLive: async (object, input, admitted) => {
          const receiver = owner.input;
          if (!receiver || !current()) { this.options.discard(input); return; }
          await this.options.consume(object, input, () => current() && admitted(),
            (value, context) => receiver.onObject(value, context, admitted));
        },
        onPrefixAccepted: boundary => {
          if (!current()) return;
          owner.ending ||= boundary.endOfTrack;
          const identity = {}, receiver = this.options.beginPage(identity);
          if (!current()) return;
          this.page = { identity, receiver, transport: null, proof: undefined,
            accepted: { cut: seekCutAfterLocation(draft, boundary.head), advanced: true, endOfTrack: boundary.endOfTrack }, cancel };
          owner.accepted = true;
          this.options.acceptPage(identity, boundary.endOfTrack, Object.freeze({ start,
            through: Object.freeze({ ...this.page.accepted!.cut }), endOfTrack: boundary.endOfTrack,
            groupOrder: 'ascending', rangeFilters: false, trackProperties: boundary.prefixTrackProperties })); armDeadline();
        },
        onPrefixDrained: async boundary => {
          clearDeadline();
          const page = this.page;
          if (!current() || !page) return;
          const drained = new Promise<void>(resolve => { owner.drained = resolve; });
          page.receiver.onClosed('fin');
          await drained;
          if (!current()) return;
          owner.drained = null;
          if (this.ended) { cancel(); this.options.onProgress(); return; }
          const input = this.options.beginLive(owner, boundary.liveTrackProperties);
          if (!current()) { input.cancel(); return; }
          owner.input = input;
        },
        onTrackEnded: async () => {
          const input = owner.input;
          if (!current() || !input) return;
          await input.endTrack();
          if (!current()) return;
          this.ended = true; this.options.onEnded(); cancel(); this.options.onProgress();
        },
        onDeferred: () => refused(), onError: error => refused(error),
      });
      owner.bridge = bridge;
      if (current()) { armDeadline(); bridge.start(); } else cancel();
    } catch (error) { refused(error instanceof Error ? error : new Error(String(error))); }
  }
}
