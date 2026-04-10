/**
 * Timeline track parsing — media timeline (§7) and event timeline (§8).
 *
 * Media timeline tracks provide seek/DVR capability by mapping media PTS
 * to MOQT locations. Event timeline tracks associate ad-hoc metadata with
 * the broadcast indexed by wallclock time, MOQT location, or media PTS.
 *
 * @see draft-ietf-moq-msf-00 §7, §8
 * @module
 */

import type { MediaTimelineEntry, EventTimelineRecord, EventIndex, SapTimelineEntry } from './types.js';

/**
 * Parse a media timeline track payload.
 *
 * The payload is a JSON array of 3-element records:
 * `[mediaPts, [groupId, objectId], wallclockTime]`
 *
 * @param json Raw JSON string or UTF-8 bytes
 * @returns Parsed timeline entries
 * @throws {Error} If the JSON is invalid or entries are malformed
 * @see draft-ietf-moq-msf-00 §7.1
 */
export function parseMediaTimeline(
    json: string | Uint8Array,
): MediaTimelineEntry[] {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (!Array.isArray(raw)) {
        throw new Error('Media timeline must be a JSON array (§7.1)');
    }

    return raw.map((entry, i) => {
        if (!Array.isArray(entry) || entry.length !== 3) {
            throw new Error(
                `Media timeline entry[${i}]: must be a 3-element array [mediaPts, [groupId, objectId], wallclockTime] (§7.1)`,
            );
        }

        const [mediaPts, location, wallclockTime] = entry as [unknown, unknown, unknown];

        if (typeof mediaPts !== 'number') {
            throw new Error(
                `Media timeline entry[${i}]: mediaPts must be a number (§7.1)`,
            );
        }

        if (
            !Array.isArray(location) ||
            location.length !== 2 ||
            typeof location[0] !== 'number' ||
            typeof location[1] !== 'number'
        ) {
            throw new Error(
                `Media timeline entry[${i}]: location must be [groupId, objectId] (§7.1)`,
            );
        }

        if (typeof wallclockTime !== 'number') {
            throw new Error(
                `Media timeline entry[${i}]: wallclockTime must be a number (§7.1)`,
            );
        }

        return {
            mediaPts,
            location: [location[0], location[1]] as readonly [number, number],
            wallclockTime,
        };
    });
}

/**
 * Parse an event timeline track payload.
 *
 * The payload is a JSON array of record objects, each with:
 * - An index reference: exactly ONE of 't' (wallclock), 'l' (location), or 'm' (media PTS)
 * - A 'data' object
 *
 * @param json Raw JSON string or UTF-8 bytes
 * @returns Parsed event records
 * @throws {Error} If the JSON is invalid or records are malformed
 * @see draft-ietf-moq-msf-00 §8.1
 */
export function parseEventTimeline(
    json: string | Uint8Array,
): EventTimelineRecord[] {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (!Array.isArray(raw)) {
        throw new Error('Event timeline must be a JSON array (§8.1)');
    }

    return raw.map((entry, i) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error(`Event timeline record[${i}]: must be a JSON object (§8.1)`);
        }

        const obj = entry as Record<string, unknown>;

        // Validate exactly one index field
        const hasT = 't' in obj;
        const hasL = 'l' in obj;
        const hasM = 'm' in obj;
        const indexCount = (hasT ? 1 : 0) + (hasL ? 1 : 0) + (hasM ? 1 : 0);

        if (indexCount !== 1) {
            throw new Error(
                `Event timeline record[${i}]: must have exactly one index field ('t', 'l', or 'm') (§8.1)`,
            );
        }

        // Validate data field
        if (!('data' in obj)) {
            throw new Error(
                `Event timeline record[${i}]: 'data' field is required (§8.1)`,
            );
        }

        // Build and validate index values per §8.1:
        // "Wallclock time and media PTS values are JSON Number, while Location
        //  value is an Array of Numbers [groupId, objectId]."
        let index: EventIndex;
        if (hasT) {
            if (typeof obj['t'] !== 'number') {
                throw new Error(
                    `Event timeline record[${i}]: 't' index must be a number (§8.1)`,
                );
            }
            index = { t: obj['t'] };
        } else if (hasL) {
            const loc = obj['l'];
            if (
                !Array.isArray(loc) ||
                loc.length !== 2 ||
                typeof loc[0] !== 'number' ||
                typeof loc[1] !== 'number'
            ) {
                throw new Error(
                    `Event timeline record[${i}]: 'l' location index must be [groupId, objectId] (§8.1)`,
                );
            }
            index = { l: [loc[0], loc[1]] as readonly [number, number] };
        } else {
            if (typeof obj['m'] !== 'number') {
                throw new Error(
                    `Event timeline record[${i}]: 'm' index must be a number (§8.1)`,
                );
            }
            index = { m: obj['m'] };
        }

        return {
            index,
            data: obj['data'],
        };
    });
}

/**
 * Find the MOQT location for a given media PTS using binary search.
 *
 * Returns the location of the entry whose mediaPts is <= the given PTS
 * (floor match). Returns undefined if PTS is before the first entry.
 *
 * @param timeline Sorted media timeline entries
 * @param mediaPts Target media presentation timestamp in ms
 * @returns MOQT location [groupId, objectId], or undefined
 * @see draft-ietf-moq-msf-00 §7
 */
export function findLocationForPts(
    timeline: readonly MediaTimelineEntry[],
    mediaPts: number,
): readonly [number, number] | undefined {
    if (timeline.length === 0) return undefined;

    // Binary search for floor entry
    let lo = 0;
    let hi = timeline.length - 1;

    // PTS before first entry
    if (mediaPts < timeline[0]!.mediaPts) return undefined;

    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (timeline[mid]!.mediaPts <= mediaPts) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    // hi now points to the largest entry with mediaPts <= target
    return timeline[hi]!.location;
}

/**
 * Merge an incremental timeline update into an existing base timeline.
 *
 * Per §7.3: incremental updates only contain records since the last
 * timeline Object. This function appends new entries, deduplicating
 * by MOQT location.
 *
 * @param base Existing timeline entries
 * @param update Incremental update entries
 * @returns Merged timeline
 * @see draft-ietf-moq-msf-00 §7.3
 */
export function mergeMediaTimeline(
    base: MediaTimelineEntry[],
    update: MediaTimelineEntry[],
): MediaTimelineEntry[] {
    if (update.length === 0) return [...base];

    const seen = new Set<string>();
    for (const entry of base) {
        seen.add(`${entry.location[0]},${entry.location[1]}`);
    }

    const result = [...base];
    for (const entry of update) {
        const key = `${entry.location[0]},${entry.location[1]}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(entry);
        }
    }

    return result;
}

/**
 * Parse a CMSF SAP Type timeline track payload.
 *
 * The payload is a JSON array of event records with:
 * - Index: MUST be 'l' (Location) — [groupId, objectId]
 * - Data: [sapType, earliestPresentationTimeMs]
 *   where sapType is 0 (no SAP), 1, 2, or 3.
 *
 * @param json Raw JSON string or UTF-8 bytes
 * @returns Parsed SAP timeline entries
 * @throws {Error} If the JSON is invalid or records violate CMSF constraints
 * @see draft-ietf-moq-cmsf-00 §3.6.1
 */
export function parseSapTimeline(
    json: string | Uint8Array,
): SapTimelineEntry[] {
    // Parse as generic event timeline first (validates base structure)
    const records = parseEventTimeline(json);

    return records.map((record, i) => {
        // §3.6.1: "The index reference MUST be 'l' for Location"
        if (!('l' in record.index)) {
            throw new Error(
                `SAP timeline record[${i}]: index MUST be 'l' (location), not '${
                    't' in record.index ? 't' : 'm'
                }' (CMSF §3.6.1)`,
            );
        }

        // §3.6.1: "data field is a JSON Array containing two integers"
        const data = record.data;
        if (!Array.isArray(data) || data.length !== 2 ||
            typeof data[0] !== 'number' || typeof data[1] !== 'number') {
            throw new Error(
                `SAP timeline record[${i}]: data MUST be an array of two integers [sapType, ept] (CMSF §3.6.1)`,
            );
        }

        const sapType = data[0] as number;
        const ept = data[1] as number;

        // §3.6.1: "allowed value of 0,1,2 or 3"
        if (sapType < 0 || sapType > 3 || !Number.isInteger(sapType)) {
            throw new Error(
                `SAP timeline record[${i}]: SAP type must be 0, 1, 2, or 3; got ${sapType} (CMSF §3.6.1)`,
            );
        }

        const loc = (record.index as { l: readonly [number, number] }).l;

        return {
            location: loc,
            sapType,
            earliestPresentationTimeMs: ept,
        };
    });
}
