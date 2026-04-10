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
  /** Base64-encoded initialization data. @see §5.1.20 */
  readonly initData?: string;
}

/** Options for buildCatalog. */
export interface BuildCatalogOptions {
  readonly tracks: readonly CatalogBuilderTrack[];
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
    version: 1,
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
    tracks.push(track);
  }

  catalog.tracks = tracks;

  return new TextEncoder().encode(JSON.stringify(catalog));
}
