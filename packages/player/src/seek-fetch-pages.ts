import { MAX_VARINT, MAX_VI64 } from '@openmoq/transport';
import type { SeekFetchResponse } from './seek-fetch-requests.js';
import type { TimelineState } from './timeline-manager.js';
import { nativeTimeUs, type FractionUs } from './presentation-placement.js';

type Draft = 14 | 16 | 18 | 22;
export type SeekFetchCut =
  | { readonly kind: 'before'; readonly groupId: bigint; readonly objectId: bigint }
  | { readonly kind: 'after-group'; readonly groupId: bigint };
interface Location { readonly groupId: bigint; readonly objectId: bigint; }
interface IndexedLocation extends Location { readonly mediaPts: number; }

export interface SeekFetchPageProof {
  readonly trackName: string;
  readonly cut: SeekFetchCut;
  readonly publishedThrough: Location;
  readonly requestedThrough?: SeekFetchCut;
}
export interface SeekFetchPageInput {
  readonly draftVersion: Draft;
  readonly trackName: string;
  /** Caller checks the issued timeline's source/namespace and consumer epoch. */
  readonly timeline: Pick<TimelineState, 'entries' | 'depends' | 'isLive'>;
  readonly cut: SeekFetchCut;
  readonly endOfTrack: boolean;
  /** Initial media preparation can include the last indexed Object itself.
   * This proves one finite published range, not a current live head. */
  readonly includeIndexedTip?: boolean;
  /** Preparation may read the first indexed higher Object to witness group closure.
   * This bounds a request; only accepted data/range evidence closes the group. */
  readonly preparingGroup?: bigint;
  /** One stalled page/probe, not request history. Clear on cursor progress. */
  readonly lastNonProgress?: SeekFetchPageProof;
}
export type SeekFetchPagePlan =
  | { readonly kind: 'fetch-page'; readonly start: Location; readonly end: Location;
      readonly through: SeekFetchCut; readonly proof: SeekFetchPageProof }
  | { readonly kind: 'probe-live'; readonly indexedTip: IndexedLocation; readonly proof: SeekFetchPageProof }
  | { readonly kind: 'wait-for-index'; readonly reason: 'no-index' | 'timeline-does-not-cover-track'
      | 'cursor-not-indexed' | 'index-behind-cursor' | 'no-new-publication' | 'no-new-indexed-range' | 'address-space-exhausted' }
  | { readonly kind: 'finished'; readonly cut: SeekFetchCut };

// Application paging target, not an MSF guarantee or a bound on Object duration.
const PAGE_MS = 5000;

function maximum(draft: Draft): bigint {
  if (draft === 14 || draft === 16) return MAX_VARINT;
  if (draft === 18 || draft === 22) return MAX_VI64;
  throw new RangeError('Unsupported FETCH page draft');
}
function check(value: bigint, max: bigint): void {
  if (typeof value !== 'bigint' || value < 0n || value > max) throw new RangeError('FETCH Location exceeds its wire integer domain');
}
function before(groupId: bigint, objectId = 0n): SeekFetchCut { return { kind: 'before', groupId, objectId }; }
function afterGroup(groupId: bigint, max: bigint): SeekFetchCut {
  return groupId === max ? { kind: 'after-group', groupId } : before(groupId + 1n);
}
function normalize(draft: Draft, cut: SeekFetchCut): SeekFetchCut {
  const max = maximum(draft);
  check(cut.groupId, max);
  if (cut.kind === 'after-group') return afterGroup(cut.groupId, max);
  if (cut.kind !== 'before') throw new TypeError('Invalid FETCH cut');
  check(cut.objectId, max);
  return before(cut.groupId, cut.objectId);
}
function compare(a: SeekFetchCut, b: SeekFetchCut): number {
  if (a.groupId !== b.groupId) return a.groupId < b.groupId ? -1 : 1;
  if (a.kind === 'after-group') return b.kind === 'after-group' ? 0 : 1;
  if (b.kind === 'after-group') return -1;
  return a.objectId === b.objectId ? 0 : a.objectId < b.objectId ? -1 : 1;
}
function compareLocations(a: Location, b: Location): number {
  return compare(before(a.groupId, a.objectId), before(b.groupId, b.objectId));
}

/** Exclusive application boundary after an inclusive actual publisher Location; not a FETCH_OK. */
export function seekCutAfterLocation(draft: Draft, head: Location): SeekFetchCut {
  const max = maximum(draft), { groupId, objectId } = head;
  check(groupId, max); check(objectId, max);
  return objectId === max ? afterGroup(groupId, max) : before(groupId, objectId + 1n);
}

/** d14/16 §9.17 / d18 §10.13 use one-past or whole-group zero; d22 §9.12 is inclusive. */
export function seekFetchResponseCut(draft: Draft, response: SeekFetchResponse): SeekFetchCut {
  const { group, object } = response.endLocation;
  if (draft === 22) return seekCutAfterLocation(draft, { groupId: group, objectId: object });
  const max = maximum(draft);
  check(group, max); check(object, max);
  return object === 0n ? afterGroup(group, max) : before(group, object);
}

/** Pure calculation; the engine commits only after accepted OK, FIN and work settlement. */
export function advanceSeekFetchCut(draft: Draft, previous: SeekFetchCut, response: SeekFetchResponse): {
  readonly cut: SeekFetchCut; readonly advanced: boolean; readonly endOfTrack: boolean;
} {
  const cut = seekFetchResponseCut(draft, response), order = compare(cut, normalize(draft, previous));
  if (order < 0) throw new RangeError('FETCH response cut precedes the current cut');
  if (typeof response.endOfTrack !== 'boolean') throw new TypeError('Expected normalized End Of Track boolean');
  return { cut, advanced: order > 0, endOfTrack: response.endOfTrack };
}

function index(draft: Draft, entries: SeekFetchPageInput['timeline']['entries']): IndexedLocation[] {
  const max = maximum(draft);
  const sorted = entries.map(entry => {
    if (!Number.isSafeInteger(entry.mediaPts)
        || !entry.location.every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new RangeError('Timeline entries need exact integer timestamps and nonnegative Locations');
    }
    const groupId = BigInt(entry.location[0]), objectId = BigInt(entry.location[1]);
    check(groupId, max); check(objectId, max);
    return { groupId, objectId, mediaPts: entry.mediaPts };
  }).sort(compareLocations);
  const result: IndexedLocation[] = [];
  for (const item of sorted) {
    const prior = result[result.length - 1];
    if (prior && compareLocations(prior, item) === 0) {
      if (prior.mediaPts !== item.mediaPts) throw new RangeError('Contradictory timeline timestamps for one Location');
      continue;
    }
    result.push(item);
  }
  return result;
}

/** SDK request endpoints stay one-past on all drafts, including the d22 encoder. */
function endBefore(boundary: Location): Location {
  if (boundary.objectId > 0n) return { groupId: boundary.groupId, objectId: boundary.objectId };
  if (boundary.groupId === 0n) throw new RangeError('Cannot end a page before the first Location');
  return { groupId: boundary.groupId - 1n, objectId: 0n };
}

/** MSF §7 entries prove publication, not cache availability or a current live head. */
export function planSeekFetchPage(options: SeekFetchPageInput): SeekFetchPagePlan {
  const draft = options.draftVersion, cut = normalize(draft, options.cut);
  const preparingGroup = options.preparingGroup;
  if (preparingGroup !== undefined) check(preparingGroup, maximum(draft));
  if (typeof options.endOfTrack !== 'boolean') throw new TypeError('Expected End Of Track boolean');
  if (options.endOfTrack) return { kind: 'finished', cut };
  if (cut.kind === 'after-group') return { kind: 'wait-for-index', reason: 'address-space-exhausted' };
  if (!options.timeline.depends.includes(options.trackName)) return { kind: 'wait-for-index', reason: 'timeline-does-not-cover-track' };
  const entries = index(draft, options.timeline.entries), tip = entries[entries.length - 1];
  if (!tip) return { kind: 'wait-for-index', reason: 'no-index' };
  const prior = options.lastNonProgress;
  const stalled = prior?.trackName === options.trackName && compare(normalize(draft, prior.cut), cut) === 0 ? prior : undefined;
  if (stalled) {
    check(stalled.publishedThrough.groupId, maximum(draft)); check(stalled.publishedThrough.objectId, maximum(draft));
    if (compareLocations(tip, stalled.publishedThrough) <= 0) return { kind: 'wait-for-index', reason: 'no-new-publication' };
  }
  let anchor: IndexedLocation | undefined;
  for (const item of entries) {
    if (compare(before(item.groupId, item.objectId), cut) <= 0) anchor = item;
    else break;
  }
  if (!anchor) return { kind: 'wait-for-index', reason: 'cursor-not-indexed' };
  const tipOrder = compare(cut, before(tip.groupId, tip.objectId));
  if (tipOrder > 0) return { kind: 'wait-for-index', reason: 'index-behind-cursor' };
  const proof: SeekFetchPageProof = { trackName: options.trackName, cut, publishedThrough: { groupId: tip.groupId, objectId: tip.objectId } };
  if (tipOrder === 0 && options.includeIndexedTip) {
    const max = maximum(draft);
    const through = tip.objectId === max ? afterGroup(tip.groupId, max) : before(tip.groupId, tip.objectId + 1n);
    return { kind: 'fetch-page', start: { groupId: cut.groupId, objectId: cut.objectId },
      end: { groupId: tip.groupId, objectId: tip.objectId === max ? 0n : tip.objectId + 1n }, through,
      proof: { ...proof, requestedThrough: { ...through } } };
  }
  if (tipOrder === 0) return options.timeline.isLive && preparingGroup === undefined
    ? { kind: 'probe-live', indexedTip: { ...tip }, proof }
    : { kind: 'wait-for-index', reason: 'no-new-indexed-range' };
  const previousEnd = stalled?.requestedThrough ? normalize(draft, stalled.requestedThrough) : undefined;
  const candidates = entries.filter(item => {
    const at = before(item.groupId, item.objectId);
    return compare(at, cut) > 0 && (!previousEnd || compare(at, previousEnd) > 0);
  });
  if (!candidates.length) return { kind: 'wait-for-index', reason: 'no-new-indexed-range' };
  const target = Math.min(Number.MAX_SAFE_INTEGER, anchor.mediaPts + PAGE_MS);
  let boundary = candidates[0]!;
  // MSF does not require monotone PTS. Without it, use one proven interval.
  const timed = entries.every((item, i) => i === 0 || item.mediaPts >= entries[i - 1]!.mediaPts);
  if (timed) for (const item of candidates) {
    if (item.mediaPts > target) break;
    boundary = item;
  }
  if (preparingGroup !== undefined && boundary.groupId > preparingGroup) {
    const higher = entries.find(item => item.groupId > preparingGroup)!;
    const through = seekCutAfterLocation(draft, higher);
    // New distant publication must not repeatedly fetch an unchanged witness.
    if (compare(through, cut) <= 0 || previousEnd && compare(through, previousEnd) <= 0) {
      return { kind: 'wait-for-index', reason: 'no-new-indexed-range' };
    }
    return { kind: 'fetch-page', start: { groupId: cut.groupId, objectId: cut.objectId },
      end: { groupId: higher.groupId, objectId: higher.objectId === maximum(draft) ? 0n : higher.objectId + 1n }, through,
      proof: { ...proof, requestedThrough: { ...through } } };
  }
  const through = before(boundary.groupId, boundary.objectId);
  return { kind: 'fetch-page', start: { groupId: cut.groupId, objectId: cut.objectId }, end: endBefore(boundary), through,
    proof: { ...proof, requestedThrough: { ...through } } };
}

export interface SeekQualityCandidateInput {
  readonly draftVersion: Draft;
  readonly trackName: string;
  /** Caller proves common source, namespace, alternate set and current ownership. */
  readonly timeline: Pick<TimelineState, 'entries' | 'depends'>;
  readonly timestampRounding: 'nearest' | 'floor';
  /** Slope-one source-to-native anchor, including the actual native timestampOffset. */
  readonly placement: { readonly sourceTimeUs: bigint; readonly rebasedTimeUs: FractionUs };
  readonly headSeconds: number;
  /** End of the observed contiguous buffered range containing head. */
  readonly bufferedEndSeconds: number;
}
type QualityIndexRefusal = 'timeline-does-not-cover-track' | 'no-index' | 'no-indexed-group-start';
export type SeekQualityCandidatePlan =
  | { readonly kind: 'candidate'; readonly location: Location; readonly indexedPts: number }
  | { readonly kind: 'unavailable'; readonly reason: QualityIndexRefusal | 'no-covered-future-entry' };

export type SeekQualityCutInput = Omit<SeekQualityCandidateInput, 'bufferedEndSeconds'> & {
  /** Caller snapshots the monotone highest group actually submitted to native output. */
  readonly afterSubmittedGroup: bigint;
};
export type SeekQualityCutPlan =
  | Extract<SeekQualityCandidatePlan, { readonly kind: 'candidate' }>
  | { readonly kind: 'unavailable'; readonly reason: QualityIndexRefusal | 'no-unsubmitted-future-entry' };

function qualityProjection(options: Pick<SeekQualityCandidateInput, 'placement' | 'timestampRounding'>) {
  const { placement, timestampRounding } = options;
  if (timestampRounding !== 'nearest' && timestampRounding !== 'floor') throw new RangeError('Unknown timeline timestamp rounding');
  if (!placement || typeof placement.sourceTimeUs !== 'bigint' || !placement.rebasedTimeUs
      || typeof placement.rebasedTimeUs.numerator !== 'bigint' || typeof placement.rebasedTimeUs.denominator !== 'bigint'
      || placement.rebasedTimeUs.denominator <= 0n) throw new RangeError('Invalid native presentation anchor');
  const { numerator, denominator } = placement.rebasedTimeUs;
  return { denominator, shift: numerator - placement.sourceTimeUs * denominator,
    lowerUs: timestampRounding === 'nearest' ? 500n : 0n, upperUs: timestampRounding === 'nearest' ? 500n : 1000n };
}

function qualityGroupStarts(options: Pick<SeekQualityCandidateInput, 'draftVersion' | 'trackName' | 'timeline'>): IndexedLocation[] | QualityIndexRefusal {
  if (!options.timeline.depends.includes(options.trackName)) return 'timeline-does-not-cover-track';
  const entries = index(options.draftVersion, options.timeline.entries);
  if (!entries.length) return 'no-index';
  // index() returns validated, deduplicated Location order without changing input.
  const starts = entries.filter(item => item.objectId === 0n);
  return starts.length ? starts : 'no-indexed-group-start';
}

/**
 * Pure preparation prefilter, not RAP, native coverage or ready proof.
 * MSF nearest/floor index uncertainty may intersect (head, bufferedEnd];
 * the retained candidate must later prove its actual mapped sample boundary.
 */
export function selectSeekQualityCandidate(options: SeekQualityCandidateInput): SeekQualityCandidatePlan {
  maximum(options.draftVersion);
  const { headSeconds, bufferedEndSeconds } = options;
  if (!Number.isFinite(headSeconds) || headSeconds < 0 || !Number.isFinite(bufferedEndSeconds)
      || bufferedEndSeconds < headSeconds) throw new RangeError('Invalid observed quality selection window');
  const { denominator, shift, lowerUs, upperUs } = qualityProjection(options);
  const starts = qualityGroupStarts(options);
  if (typeof starts === 'string') return { kind: 'unavailable', reason: starts };
  // One common translation preserves PTS ordering even when Location order does not.
  starts.sort((a, b) => a.mediaPts === b.mediaPts
    ? compareLocations(a, b) : a.mediaPts < b.mediaPts ? -1 : 1);
  if (headSeconds !== bufferedEndSeconds) {
    const head = nativeTimeUs(headSeconds), end = nativeTimeUs(bufferedEndSeconds);
    if (head === null || end === null) throw new RangeError('Invalid observed quality selection window');
    for (const item of starts) {
      const projected = BigInt(item.mediaPts) * 1000n * denominator + shift;
      const low = projected - lowerUs * denominator, high = projected + upperUs * denominator;
      if (high * head.denominator > head.numerator * denominator && low * end.denominator <= end.numerator * denominator) {
        return { kind: 'candidate', location: { groupId: item.groupId, objectId: item.objectId }, indexedPts: item.mediaPts };
      }
    }
  }
  return { kind: 'unavailable', reason: 'no-covered-future-entry' };
}

/**
 * Pure ordered cut prefilter, not readiness, RAP, gapless or native proof.
 * Only an explicit Object0 beyond the submitted group with a possible mapped
 * start after head qualifies. The actor must independently prove the actual cut.
 */
export function selectSeekQualityCut(options: SeekQualityCutInput): SeekQualityCutPlan {
  const max = maximum(options.draftVersion);
  if (!Number.isFinite(options.headSeconds) || options.headSeconds < 0) throw new RangeError('Invalid observed quality selection head');
  check(options.afterSubmittedGroup, max);
  const { denominator, shift, upperUs } = qualityProjection(options);
  const starts = qualityGroupStarts(options);
  if (typeof starts === 'string') return { kind: 'unavailable', reason: starts };
  const head = nativeTimeUs(options.headSeconds);
  if (head === null) throw new RangeError('Invalid observed quality selection head');
  for (const item of starts) {
    if (item.groupId <= options.afterSubmittedGroup) continue;
    const high = (BigInt(item.mediaPts) * 1000n + upperUs) * denominator + shift;
    if (high * head.denominator > head.numerator * denominator) {
      return { kind: 'candidate', location: { groupId: item.groupId, objectId: item.objectId }, indexedPts: item.mediaPts };
    }
  }
  return { kind: 'unavailable', reason: 'no-unsubmitted-future-entry' };
}


export interface FrameQualityCutInput {
  readonly draftVersion: Draft;
  readonly trackName: string;
  /** Caller proves shared source, namespace, alternate set and current output ownership. */
  readonly timeline: Pick<TimelineState, 'entries' | 'depends'>;
  /** Maximum observed playhead and committed video output position, in indexed content time. */
  readonly afterContentMs: number;
}
export type FrameQualityCutPlan =
  | Extract<SeekQualityCandidatePlan, { readonly kind: 'candidate' }>
  | { readonly kind: 'unavailable'; readonly reason: QualityIndexRefusal | 'no-future-content-entry' };

/** Candidate selection only; the actor must prove independent output and a still-future mapped cut. */
export function selectFrameQualityCut(options: FrameQualityCutInput): FrameQualityCutPlan {
  maximum(options.draftVersion);
  if (!Number.isFinite(options.afterContentMs) || options.afterContentMs < 0) throw new RangeError('Invalid frame content frontier');
  const starts = qualityGroupStarts(options);
  if (typeof starts === 'string') return { kind: 'unavailable', reason: starts };
  starts.sort((a, b) => a.mediaPts === b.mediaPts ? compareLocations(a, b) : a.mediaPts < b.mediaPts ? -1 : 1);
  const next = starts.find(entry => entry.mediaPts > options.afterContentMs);
  return next ? { kind: 'candidate', location: { groupId: next.groupId, objectId: next.objectId }, indexedPts: next.mediaPts }
    : { kind: 'unavailable', reason: 'no-future-content-entry' };
}
