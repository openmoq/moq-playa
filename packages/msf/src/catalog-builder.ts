/**
 * Catalog builder — constructs MSF catalog JSON for publishers.
 *
 * Produces a UTF-8 encoded JSON payload conforming to draft-ietf-moq-msf-00 §5.
 * The payload is a single MoQ object published on the "catalog" track
 * (group 0, object 0).
 *
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @see draft-ietf-moq-msf-00 §5.1.1 (version)
 * @module
 */

import { assertFiniteBuilderInput } from './catalog-validate.js';

/** Track definition for catalog construction. */
export interface CatalogBuilderTrack {
  /** Track name (unique within namespace). @see §5.1.11 */
  readonly name: string;
  /** Packaging format. @see §5.1.12 */
  readonly packaging: 'loc' | 'cmaf' | 'mediatimeline' | 'eventtimeline';
  /** Whether this is a live track. @see §5.1.15 */
  readonly isLive: boolean;
  /** Track role. @see §5.1.14 */
  readonly role?: string;
  /** Codec string (WebCodecs Codec Registry). @see §5.1.24 */
  readonly codec?: string;
  /** Encoded width in pixels. @see §5.1.29 */
  readonly width?: number;
  /** Encoded height in pixels. @see §5.1.30 */
  readonly height?: number;
  /** Frames per second. @see §5.1.26 */
  readonly framerate?: number;
  /** Bitrate in bits per second. @see §5.1.28 */
  readonly bitrate?: number;
  /** Audio sample rate in Hz. @see §5.1.31 */
  readonly samplerate?: number;
  /** Audio channel configuration. @see §5.1.32 */
  readonly channelConfig?: string;
  /** Render group for A/V sync. @see §5.1.18 */
  readonly renderGroup?: number;
  /** Base64-encoded initialization data (MSF-00 inline form). @see §5.1.20 */
  readonly initData?: string;
  /** Reference to a root {@link BuildCatalogOptions.initDataList} id (MSF-01 init-by-reference). @see draft-ietf-moq-msf-01 §5.2.13 */
  readonly initRef?: string;
}

/** A root Initialization Data List entry (MSF-01 §5.1.7). `data` is opaque base64. */
export interface CatalogBuilderInitDataEntry {
  readonly id: string;
  /** This spec revision defines only "inline". @see draft-ietf-moq-msf-01 §5.1.7 */
  readonly type: string;
  readonly data: string;
}

/** Options for buildCatalog. */
export interface BuildCatalogOptions {
  readonly tracks: readonly CatalogBuilderTrack[];
  /**
   * Catalog version to emit. `1` (default) writes the numeric MSF-00 form; the
   * string `"1"` writes the MSF-01/CMSF-01 form, which a compliant parser reads
   * identically but which pairs with the init-by-reference fields below.
   * @see draft-ietf-moq-msf-00 §5.1.1 / draft-ietf-moq-msf-01 §5.1.1
   */
  readonly version?: 1 | '1';
  /**
   * Root Initialization Data List (MSF-01/CMSF-01). When present it is emitted at
   * the catalog root and tracks reference entries by `initRef` instead of
   * carrying inline `initData`.
   * @see draft-ietf-moq-msf-01 §5.1.7
   */
  readonly initDataList?: readonly CatalogBuilderInitDataEntry[];
}

/**
 * Build an MSF catalog as a UTF-8 encoded JSON payload.
 *
 * @param options Catalog options with track definitions
 * @returns Uint8Array containing UTF-8 JSON
 * @see draft-ietf-moq-msf-00 §5
 */
export function buildCatalog(options: BuildCatalogOptions): Uint8Array {
  const catalog: Record<string, unknown> = {
    version: options.version ?? 1,
  };

  const tracks: Record<string, unknown>[] = [];

  for (const t of options.tracks) {
    const track: Record<string, unknown> = {
      name: t.name,
      packaging: t.packaging,
      isLive: t.isLive,
    };
    if (t.role !== undefined) track.role = t.role;
    if (t.codec !== undefined) track.codec = t.codec;
    if (t.width !== undefined) track.width = t.width;
    if (t.height !== undefined) track.height = t.height;
    if (t.framerate !== undefined) track.framerate = t.framerate;
    if (t.bitrate !== undefined) track.bitrate = t.bitrate;
    if (t.samplerate !== undefined) track.samplerate = t.samplerate;
    if (t.channelConfig !== undefined) track.channelConfig = t.channelConfig;
    if (t.renderGroup !== undefined) track.renderGroup = t.renderGroup;
    if (t.initData !== undefined) track.initData = t.initData;
    if (t.initRef !== undefined) track.initRef = t.initRef;
    tracks.push(track);
  }

  catalog.tracks = tracks;

  // MSF-01/CMSF-01 root Initialization Data List (§5.1.7), emitted after tracks
  // so verbose init blobs sit toward the end of the document.
  if (options.initDataList !== undefined) {
    catalog.initDataList = options.initDataList.map((e) => ({ id: e.id, type: e.type, data: e.data }));
  }

  // `JSON.stringify(Infinity)` is `"null"`, so a non-finite numeric field would
  // be silently emitted as `null` in the payload. Reject before serializing.
  assertFiniteBuilderInput(catalog);

  return new TextEncoder().encode(JSON.stringify(catalog));
}
