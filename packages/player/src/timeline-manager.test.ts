/**
 * Timeline manager tests.
 * @see draft-ietf-moq-msf-00 §7 (Media Timeline track)
 */

import { describe, it, expect } from 'vitest';
import type { CatalogTrack } from '@moqt/msf';
import {
  createTimelineState,
  processTimelineObject,
  findSeekTarget,
  getTimelineDuration,
} from './timeline-manager.js';

/** §5.3.8: VOD catalog track with mediatimeline packaging */
function vodTimelineTrack(overrides?: Partial<CatalogTrack>): CatalogTrack {
  return {
    name: 'timeline',
    packaging: 'mediatimeline',
    isLive: false,
    trackDuration: 10000,
    depends: ['video'],
    mimeType: 'application/json',
    ...overrides,
  } as CatalogTrack;
}

/** §5.3.8: Live catalog track with mediatimeline packaging */
function liveTimelineTrack(overrides?: Partial<CatalogTrack>): CatalogTrack {
  return {
    name: 'history',
    packaging: 'mediatimeline',
    isLive: true,
    depends: ['1080p-video', 'audio'],
    mimeType: 'application/json',
    ...overrides,
  } as CatalogTrack;
}

/** Encode a media timeline JSON payload as Uint8Array per §7.1 */
function encodeTimeline(entries: [number, [number, number], number][]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(entries));
}

describe('timeline-manager', () => {
  describe('createTimelineState', () => {
    it('extracts trackDuration, isLive, depends from VOD catalog track (§7.2)', () => {
      const state = createTimelineState(vodTimelineTrack());

      expect(state.trackName).toBe('timeline');
      expect(state.trackDuration).toBe(10000);
      expect(state.isLive).toBe(false);
      expect(state.depends).toEqual(['video']);
      expect(state.entries).toEqual([]);
    });

    it('creates state from live catalog track without trackDuration (§5.1.37)', () => {
      const state = createTimelineState(liveTimelineTrack());

      expect(state.trackName).toBe('history');
      expect(state.trackDuration).toBeUndefined();
      expect(state.isLive).toBe(true);
      expect(state.depends).toEqual(['1080p-video', 'audio']);
    });
  });

  describe('processTimelineObject', () => {
    it('parses JSON payload into timeline entries (§7.1)', () => {
      const state = createTimelineState(vodTimelineTrack());
      const payload = encodeTimeline([
        [0, [0, 0], 0],
        [2002, [1, 0], 0],
        [4004, [2, 0], 0],
      ]);

      const updated = processTimelineObject(state, payload);

      expect(updated.entries).toHaveLength(3);
      expect(updated.entries[0]).toEqual({ mediaPts: 0, location: [0, 0], wallclockTime: 0 });
      expect(updated.entries[2]).toEqual({ mediaPts: 4004, location: [2, 0], wallclockTime: 0 });
    });

    it('merges incremental updates without duplicates (§7.3)', () => {
      const state = createTimelineState(vodTimelineTrack());

      // First object: independent timeline (§7.3: first object of each group)
      const first = processTimelineObject(state, encodeTimeline([
        [0, [0, 0], 0],
        [2002, [1, 0], 0],
      ]));

      // Second object: incremental update (§7.3: subsequent objects)
      const second = processTimelineObject(first, encodeTimeline([
        [4004, [2, 0], 0],
        [6006, [3, 0], 0],
      ]));

      expect(second.entries).toHaveLength(4);
      expect(second.entries[3].mediaPts).toBe(6006);
    });
  });

  describe('findSeekTarget', () => {
    it('returns correct group/object for known PTS (§7)', () => {
      let state = createTimelineState(vodTimelineTrack());
      state = processTimelineObject(state, encodeTimeline([
        [0, [0, 0], 0],
        [2002, [1, 0], 0],
        [4004, [2, 0], 0],
        [6006, [3, 0], 0],
      ]));

      const target = findSeekTarget(state, 5000);

      // Floor match: 4004 <= 5000, so group 2
      expect(target).toEqual({ groupId: 2, objectId: 0 });
    });

    it('returns undefined for PTS before first entry', () => {
      let state = createTimelineState(vodTimelineTrack());
      state = processTimelineObject(state, encodeTimeline([
        [2000, [1, 0], 0],
        [4000, [2, 0], 0],
      ]));

      const target = findSeekTarget(state, 500);

      expect(target).toBeUndefined();
    });

    it('returns last entry for PTS at or beyond end', () => {
      let state = createTimelineState(vodTimelineTrack());
      state = processTimelineObject(state, encodeTimeline([
        [0, [0, 0], 0],
        [2002, [1, 0], 0],
        [4004, [2, 0], 0],
      ]));

      const target = findSeekTarget(state, 99999);

      expect(target).toEqual({ groupId: 2, objectId: 0 });
    });
  });

  describe('getTimelineDuration', () => {
    it('returns trackDuration when available (§5.1.37)', () => {
      const state = createTimelineState(vodTimelineTrack({ trackDuration: 8072340 }));

      expect(getTimelineDuration(state)).toBe(8072340);
    });

    it('falls back to max mediaPts from entries when no trackDuration', () => {
      let state = createTimelineState(liveTimelineTrack());
      state = processTimelineObject(state, encodeTimeline([
        [0, [0, 0], 1759924158381],
        [2002, [1, 0], 1759924160383],
        [8008, [4, 0], 1759924166389],
      ]));

      expect(getTimelineDuration(state)).toBe(8008);
    });

    it('returns undefined when no trackDuration and no entries', () => {
      const state = createTimelineState(liveTimelineTrack());

      expect(getTimelineDuration(state)).toBeUndefined();
    });
  });
});
