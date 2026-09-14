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
export function mediaTrackPackaging(packaging: string | undefined): TrackPackaging {
  return isMsePackaging(packaging) ? packaging : 'loc';
}
