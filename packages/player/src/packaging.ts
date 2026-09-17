/**
 * Packaging predicates shared by the player and its embedders.
 *
 * `cmaf` and `locmaf` tracks share one delivery path: a CMAF Header signalled
 * through the catalog (initData, or initRef → root initDataList), MSE with a
 * <video> sink, no LOC header parsing and no WebCodecs decoder. They differ
 * only in the per-object encoding, which the SubscriptionManager routes to
 * separate callbacks.
 *
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
 * @see draft-einarsson-moq-locmaf-01 §5, §6 (catalog signalling, CMAF Header Delivery)
 * @module
 */

import type { TrackPackaging } from './subscription-manager.js';

/**
 * How a LOCMAF track is consumed (draft-einarsson-moq-locmaf-01 §16):
 * `mse` reconstructs each Object into a canonical CMAF chunk for MSE (the
 * chunk interface); `frame` slices each Object into coded samples for the
 * LOC WebCodecs pipeline (the frame interface).
 */
export type LocmafDecoding = 'mse' | 'frame';

/**
 * True when a track of this packaging is played through MSE with a CMAF init
 * bootstrap (cmaf, locmaf); false for LOC, metadata packagings and unknown.
 */
export function isMsePackaging(packaging: string | undefined): packaging is 'cmaf' | 'locmaf' {
  return packaging === 'cmaf' || packaging === 'locmaf';
}

/**
 * The SubscriptionManager packaging for a selected media track: 'cmaf' and
 * 'locmaf' are preserved as distinct values, everything else collapses to 'loc'.
 */
/**
 * True when a track of this packaging plays through MSE in a player configured
 * with `locmafDecoding`: cmaf always, locmaf unless the frame path is selected,
 * never LOC, metadata packagings or unknown.
 */
export function usesMsePath(packaging: string | undefined, locmafDecoding: LocmafDecoding | undefined): boolean {
  if (packaging === 'locmaf') return locmafDecoding !== 'frame';
  return packaging === 'cmaf';
}

export function mediaTrackPackaging(packaging: string | undefined): TrackPackaging {
  return isMsePackaging(packaging) ? packaging : 'loc';
}
