/**
 * Timeline state management — pure functions for media timeline tracks.
 *
 * Manages the lifecycle of MSF media timeline data: parsing timeline
 * objects, maintaining merged timeline state, and performing PTS→location
 * lookups for seek operations.
 *
 * @see draft-ietf-moq-msf-00 §7 (Media Timeline track)
 * @module
 */

import type { CatalogTrack, MediaTimelineEntry } from '@moqt/msf';
import { parseMediaTimeline, mergeMediaTimeline, findLocationForPts } from '@moqt/msf';

/**
 * Materialized state of a media timeline track.
 * @see draft-ietf-moq-msf-00 §7
 */
export interface TimelineState {
  /** Merged timeline entries from all received objects. §7.1 */
  entries: MediaTimelineEntry[];
  /** Track duration from catalog, if available. §5.1.37 */
  trackDuration: number | undefined;
  /** Whether the source is live (growing timeline) or VOD (static). §5.1.15 */
  isLive: boolean;
  /** Name of this timeline track in the catalog. */
  trackName: string;
  /** Track names this timeline covers. §7.2: MUST have depends. */
  depends: string[];
}

/**
 * Create initial timeline state from a catalog track.
 * @see draft-ietf-moq-msf-00 §7.2 (catalog requirements)
 */
export function createTimelineState(track: CatalogTrack): TimelineState {
  return {
    entries: [],
    trackDuration: track.trackDuration,
    isLive: track.isLive,
    trackName: track.name,
    depends: track.depends ?? [],
  };
}

/**
 * Process a timeline object payload and merge into existing state.
 *
 * §7.3: The first object of each group is independent (full timeline).
 * Subsequent objects are incremental updates. We use mergeMediaTimeline
 * to handle both cases — it deduplicates by location.
 *
 * @see draft-ietf-moq-msf-00 §7.3 (timeline updating)
 */
export function processTimelineObject(state: TimelineState, payload: Uint8Array): TimelineState {
  const newEntries = parseMediaTimeline(payload);
  return {
    ...state,
    entries: mergeMediaTimeline(state.entries, newEntries),
  };
}

/**
 * Find the MOQT location for a seek target PTS.
 * Returns the group/object at or before the given media PTS (floor match).
 *
 * @returns Group/object IDs for the seek target, or undefined if PTS
 *          is before the first timeline entry.
 * @see draft-ietf-moq-msf-00 §7.1 (media presentation timestamp)
 */
export function findSeekTarget(
  state: TimelineState,
  timeMs: number,
): { groupId: number; objectId: number } | undefined {
  const location = findLocationForPts(state.entries, timeMs);
  if (!location) return undefined;
  return { groupId: location[0], objectId: location[1] };
}

/**
 * Get the known duration of the timeline.
 *
 * Prefers the catalog's trackDuration (§5.1.37) when available.
 * Falls back to the maximum mediaPts from received timeline entries.
 *
 * @returns Duration in milliseconds, or undefined if unknown.
 */
export function getTimelineDuration(state: TimelineState): number | undefined {
  if (state.trackDuration !== undefined) return state.trackDuration;
  if (state.entries.length === 0) return undefined;
  const last = state.entries[state.entries.length - 1];
  return last?.mediaPts;
}
