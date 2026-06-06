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
 */
export type DraftVersion = 14 | 16 | 18;

/** Draft versions with a fully-wired wire codec today. */
export const WIRED_DRAFTS: readonly DraftVersion[] = [14, 16, 18];

/** Whether `v` has a fully-wired control + data codec. */
export function isWiredDraft(v: number): v is DraftVersion {
  return v === 14 || v === 16 || v === 18;
}
