/**
 * MSF catalog types.
 *
 * All types correspond to fields defined in draft-ietf-moq-msf-00 §5.1.
 * Each field is annotated with the spec section that defines it.
 *
 * @see draft-ietf-moq-msf-00 §5
 * @module
 */

/**
 * Allowed packaging values.
 * @see draft-ietf-moq-msf-00 §5.1.12 Table 3
 * @see draft-ietf-moq-cmsf-00 §3.5.1 (adds 'cmaf')
 */
export type Packaging = 'loc' | 'mediatimeline' | 'eventtimeline' | 'cmaf';

/**
 * Reserved track roles.
 * Custom roles are allowed as long as they don't collide with reserved ones.
 * @see draft-ietf-moq-msf-00 §5.1.14 Table 4
 */
export type TrackRole =
    | 'video'
    | 'audio'
    | 'audiodescription'
    | 'mediatimeline'
    | 'eventtimeline'
    | 'caption'
    | 'subtitle'
    | 'signlanguage'
    | (string & {});

/**
 * Track object — a JSON object describing a single track.
 * @see draft-ietf-moq-msf-00 §5.1.9
 */
export interface CatalogTrack {
    /** @see draft-ietf-moq-msf-00 §5.1.11 — Required, unique per namespace */
    readonly name: string;
    /** @see draft-ietf-moq-msf-00 §5.1.12 — Required */
    readonly packaging: Packaging;
    /** @see draft-ietf-moq-msf-00 §5.1.15 — Required */
    readonly isLive: boolean;
    /** @see draft-ietf-moq-msf-00 §5.1.10 — Optional; inherits catalog namespace if absent */
    readonly namespace?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.14 */
    readonly role?: TrackRole;
    /** @see draft-ietf-moq-msf-00 §5.1.18 */
    readonly renderGroup?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.19 */
    readonly altGroup?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.24 (WebCodecs Codec Registry strings) */
    readonly codec?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.25 */
    readonly mimeType?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.26 — frames per second */
    readonly framerate?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.27 — time units per second */
    readonly timescale?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.28 — bits per second */
    readonly bitrate?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.29 — encoded width in pixels */
    readonly width?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.30 — encoded height in pixels */
    readonly height?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.31 — audio samples per second */
    readonly samplerate?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.32 */
    readonly channelConfig?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.33 — display width in pixels */
    readonly displayWidth?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.34 — display height in pixels */
    readonly displayHeight?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.35 — BCP 47 language tag */
    readonly lang?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.17 — human-readable label */
    readonly label?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.20 — Base64-encoded initialization data */
    readonly initData?: string;
    /** @see draft-ietf-moq-catalogformat-01 §3.2.16 — name of separate initialization track */
    readonly initTrack?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.21 — array of track names this track depends on */
    readonly depends?: string[];
    /** @see draft-ietf-moq-msf-00 §5.1.22 — temporal layer (0 = base) */
    readonly temporalId?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.23 — spatial layer (0 = base) */
    readonly spatialId?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.16 — target latency in ms; MUST NOT be present if isLive=false */
    readonly targetLatency?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.37 — track duration in ms; MUST NOT be present if isLive=true */
    readonly trackDuration?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.13 — required if packaging="eventtimeline", MUST NOT appear otherwise */
    readonly eventType?: string;
    /** @see draft-ietf-moq-msf-00 §5.1.36 — parent track name for clone operations only */
    readonly parentName?: string;

    // ─── CMSF extensions (draft-ietf-moq-cmsf-00 §3.5.2) ─────────

    /** @see draft-ietf-moq-cmsf-00 §3.5.2.1 — max SAP type at group start */
    readonly maxGrpSapStartingType?: number;
    /** @see draft-ietf-moq-cmsf-00 §3.5.2.2 — max SAP type at object start */
    readonly maxObjSapStartingType?: number;
}

/**
 * Independent (non-delta) catalog.
 * @see draft-ietf-moq-msf-00 §5.1
 */
export interface Catalog {
    /** @see draft-ietf-moq-msf-00 §5.1.1 — Required; must be 1 for this version */
    readonly version: number;
    /** @see draft-ietf-moq-msf-00 §5.1.8 — Required */
    readonly tracks: readonly CatalogTrack[];
    /** @see draft-ietf-moq-msf-00 §5.1.6 — wallclock time in ms since epoch */
    readonly generatedAt?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.7 — MUST NOT be included if false */
    readonly isComplete?: boolean;
}

/**
 * Reference to a track being removed in a delta update.
 * Per §5.1.4: MUST include name, MAY include namespace, MUST NOT have other fields.
 * @see draft-ietf-moq-msf-00 §5.1.4
 */
export interface RemoveTrackRef {
    readonly name: string;
    readonly namespace?: string;
}

/**
 * Delta (partial) catalog update.
 * @see draft-ietf-moq-msf-00 §5.2
 */
export interface CatalogDelta {
    /** @see draft-ietf-moq-msf-00 §5.1.2 — Must be true for delta updates */
    readonly deltaUpdate: true;
    /** @see draft-ietf-moq-msf-00 §5.1.6 */
    readonly generatedAt?: number;
    /** @see draft-ietf-moq-msf-00 §5.1.3 */
    readonly addTracks?: readonly CatalogTrack[];
    /** @see draft-ietf-moq-msf-00 §5.1.4 */
    readonly removeTracks?: readonly RemoveTrackRef[];
    /** @see draft-ietf-moq-msf-00 §5.1.5 — each entry MUST include parentName */
    readonly cloneTracks?: readonly CatalogTrack[];
}

/**
 * Discriminated union: either an independent catalog or a delta update.
 * Use `isDelta()` to discriminate.
 */
export type CatalogObject = Catalog | CatalogDelta;

/**
 * Materialized catalog state — the result of applying zero or more deltas
 * to an initial independent catalog.
 */
export interface CatalogState {
    readonly version: number;
    readonly tracks: CatalogTrack[];
    readonly generatedAt?: number;
    readonly isComplete?: boolean;
}

// ─── Selection types ──────────────────────────────────────────────────

/**
 * A render group — tracks designed to be rendered together.
 * Tracks with the same renderGroup SHOULD be rendered simultaneously
 * and are time-aligned.
 * @see draft-ietf-moq-msf-00 §5.1.18
 */
export interface RenderGroup {
    readonly renderGroup: number;
    readonly tracks: CatalogTrack[];
}

/**
 * An alt group — alternate versions of the same content.
 * A subscriber typically subscribes to ONE track from an alt group.
 * @see draft-ietf-moq-msf-00 §5.1.19
 */
export interface AltGroup {
    readonly altGroup: number;
    readonly tracks: CatalogTrack[];
}

/**
 * Constraints for selecting a track from a set of candidates.
 * Used with altGroup selection for ABR or quality preference.
 */
export interface TrackConstraints {
    readonly maxBitrate?: number;
    readonly minBitrate?: number;
    readonly maxWidth?: number;
    readonly maxHeight?: number;
    readonly codec?: string;
    readonly lang?: string;
    readonly role?: string;
}

// ─── Timeline types ───────────────────────────────────────────────────

/**
 * A single entry in a media timeline track payload.
 * Array of 3-element records: [mediaPts, [groupId, objectId], wallclockTime].
 * @see draft-ietf-moq-msf-00 §7.1
 */
export interface MediaTimelineEntry {
    /** Media presentation timestamp in ms. §7.1 */
    readonly mediaPts: number;
    /** MOQT Location: [groupId, objectId]. §7.1 */
    readonly location: readonly [number, number];
    /** Wallclock time in ms since epoch; 0 for VOD or unknown. §7.1 */
    readonly wallclockTime: number;
}

/**
 * Index reference for an event timeline record.
 * Exactly one of 't' (wallclock), 'l' (location), or 'm' (media PTS).
 * @see draft-ietf-moq-msf-00 §8.1
 */
export type EventIndex =
    | { readonly t: number }
    | { readonly l: readonly [number, number] }
    | { readonly m: number };

/**
 * A single record in an event timeline track payload.
 * @see draft-ietf-moq-msf-00 §8.1
 */
export interface EventTimelineRecord {
    /** Index reference — one of wallclock time, MOQT location, or media PTS. §8.1 */
    readonly index: EventIndex;
    /** Application-defined data; structure determined by eventType (§5.1.13). §8.1 */
    readonly data: unknown;
}

// ─── CMSF types (draft-ietf-moq-cmsf-00) ─────────────────────────────

/**
 * CMSF SAP event type identifier.
 * @see draft-ietf-moq-cmsf-00 §3.6.1
 */
export const CMSF_SAP_EVENT_TYPE = 'org.ietf.moq.cmsf.sap';

/**
 * A single entry in a SAP Type timeline track.
 * @see draft-ietf-moq-cmsf-00 §3.6.1
 */
export interface SapTimelineEntry {
    /** MOQT Location: [groupId, objectId]. */
    readonly location: readonly [number, number];
    /** SAP type: 0 (no SAP), 1 (IDR clean), 2 (IDR with leading), 3 (CRA with RASL). */
    readonly sapType: number;
    /** Earliest presentation timestamp in milliseconds. */
    readonly earliestPresentationTimeMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────

/**
 * MSF version supported by this implementation.
 * @see draft-ietf-moq-msf-00 §5.1.1
 */
export const MSF_VERSION = 1;

/**
 * The fixed catalog track name.
 * @see draft-ietf-moq-msf-00 §5
 */
export const CATALOG_TRACK_NAME = 'catalog';
