/**
 * Draft version identity — the single source of truth for which MoQT draft
 * revisions this library can speak. Profile pieces (control codec, data codec,
 * request policy) key off this type so version selection stays consistent.
 *
 * @see draft-ietf-moq-transport-16
 * @see draft-ietf-moq-transport-18
 * @module
 */

/**
 * Supported MoQT draft versions.
 *
 * - `14` — draft-ietf-moq-transport-14 (legacy, normalized to 16 at decode)
 * - `16` — draft-ietf-moq-transport-16 (default)
 * - `18` — draft-ietf-moq-transport-18 (fully wired: control + data codecs,
 *   uni-pair topology, request profile)
 * - `22` — draft-ietf-moq-transport-22 (the draft-18 stream model with a typed
 *   LOCATION_FILTER, fill fetch streams, PUBLISH_STATE_NOTIFY and a FETCH that
 *   carries its range as a LOCATION_FILTER). Draft 21 is not supported: 22 is
 *   draft 21 with LOCATION_FILTER framed by its type instead of a Length.
 */
export type DraftVersion = 14 | 16 | 18 | 22;

/** Draft versions with a fully-wired wire codec today. */
export const WIRED_DRAFTS: readonly DraftVersion[] = [14, 16, 18, 22];

/** Whether `v` has a fully-wired control + data codec. */
export function isWiredDraft(v: number): v is DraftVersion {
  return v === 14 || v === 16 || v === 18 || v === 22;
}

/**
 * Whether `v` uses the draft-18 stream model: a unified SETUP on a uni
 * control-stream pair, one bidi stream per request, stream-correlated
 * responses and vi64 integers. True for draft 18 and every later draft.
 */
export function isRequestStreamDraft(v: number | undefined): boolean {
  return v !== undefined && v >= 18;
}

/**
 * Whether `v` is draft 22 or later: LOCATION_FILTER (typed, no Length,
 * §9.20.9), fills, PUBLISH_STATE_NOTIFY and no Joining FETCH.
 */
export function isDraft22(v: number | undefined): boolean {
  return v !== undefined && v >= 22;
}

/** A draft with the draft-18 stream model: 18 or 22. */
export type RequestStreamDraft = 18 | 22;
