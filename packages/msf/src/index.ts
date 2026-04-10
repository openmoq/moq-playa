/**
 * @moqt/msf — MOQT Streaming Format catalog parsing, track selection,
 * delta updates, and timeline parsing.
 *
 * Implements the JSON catalog format defined in draft-ietf-moq-msf-00.
 * Provides parsing, validation, track selection, ABR support,
 * delta update application, and timeline track parsing for
 * MSF catalogs used by MOQT publishers and subscribers.
 *
 * @see draft-ietf-moq-msf-00
 * @module
 */

// ─── Types ───────────────────────────────────────────────────────────

export type {
    Packaging,
    TrackRole,
    CatalogTrack,
    Catalog,
    RemoveTrackRef,
    CatalogDelta,
    CatalogObject,
    CatalogState,
    RenderGroup,
    AltGroup,
    TrackConstraints,
    MediaTimelineEntry,
    EventIndex,
    EventTimelineRecord,
    SapTimelineEntry,
} from './types.js';

export { MSF_VERSION, CATALOG_TRACK_NAME, CMSF_SAP_EVENT_TYPE } from './types.js';

// ─── Catalog parsing ─────────────────────────────────────────────────

export { parseMsfCatalog, isDelta } from './catalog-msf00.js';
// Backward compat alias
export { parseMsfCatalog as parseCatalog } from './catalog-msf00.js';
// catalogformat-01
export { parseCatalogFormat01, applyCf01Patch } from './catalog-cf01.js';
export type { Cf01ParseResult } from './catalog-cf01.js';
// Auto-detect dispatcher
export { parseCatalogAuto } from './catalog-detect.js';

// ─── Catalog builder (publisher) ────────────────────────────────────

export { buildCatalog } from './catalog-builder.js';
export type { CatalogBuilderTrack, BuildCatalogOptions } from './catalog-builder.js';

// ─── Delta updates ───────────────────────────────────────────────────

export { parseDeltaUpdate, applyCatalogUpdate } from './delta.js';

// ─── Track selection ─────────────────────────────────────────────────

export { groupByRender, groupByAlt, selectTrack, resolveDependencies } from './selection.js';

// ─── Timeline parsing ────────────────────────────────────────────────

export {
    parseMediaTimeline,
    parseEventTimeline,
    parseSapTimeline,
    findLocationForPts,
    mergeMediaTimeline,
} from './timeline.js';
