/**
 * SubscriptionManager — routes incoming objects to playback pipelines.
 *
 * Responsibilities:
 * - Map track aliases to media types and track names
 * - Route MoqtObjects from the adapter to the correct pipeline
 * - Apply objectTransform between adapter and pipeline (E2EE insertion point)
 * - Parse LOC headers from object extensions (LOC tracks)
 * - Route CMAF objects directly to MediaSource adapter (CMAF tracks)
 *
 * @see draft-ietf-moq-transport-16 §5.1 (Subscription lifecycle)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @see draft-ietf-moq-loc-01 §2.3 (LOC Header Extensions)
 * @see draft-ietf-moq-cmsf-00 §3.3 (CMAF Object Packaging)
 * @module
 */

import type { MoqtObject } from '@moqt/transport';
import type { LocHeaders, LocHeaderOptions } from '@moqt/loc';
import { parseLocHeaders } from '@moqt/loc';
import type { DraftVersion } from '@moqt/transport';

/**
 * Packaging type for container format dispatch.
 * @see draft-ietf-moq-msf-00 §5.1.12 Table 3
 * @see draft-ietf-moq-msf-00 §8 (eventtimeline)
 */
export type TrackPackaging = 'loc' | 'cmaf' | 'init' | 'mediatimeline' | 'eventtimeline';

/** Track registration info. */
interface TrackInfo {
  readonly trackName: string;
  readonly mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline';
  readonly packaging: TrackPackaging;
}

/**
 * Manages track alias → pipeline routing.
 */
export class SubscriptionManager {
  /** Map of track alias (bigint) → track info. */
  private readonly tracks = new Map<bigint, TrackInfo>();

  /**
   * Object transform: applied to every MoqtObject before routing.
   * Return null to drop the object. May be async (e.g., crypto.subtle.decrypt()).
   * @see draft-jennings-moq-secure-objects-03 (E2EE decryption)
   */
  objectTransform: ((obj: MoqtObject) => MoqtObject | null | Promise<MoqtObject | null>) | null = null;

  /**
   * Draft version — controls KVP encoding mode for extension headers.
   *
   * Draft-14 §1.4.2: absolute type IDs.
   * Draft-16 §1.4.2: delta-encoded type IDs.
   *
   * When set, parseLocHeaders() receives `{ deltaEncoded: draftVersion !== 14 }`.
   * @see draft-ietf-moq-transport-14 §1.4.2
   * @see draft-ietf-moq-transport-16 §1.4.2
   */
  draftVersion: DraftVersion | undefined;

  /**
   * Custom extension parser — replaces parseLocHeaders() when set.
   * Used for non-LOC packaging formats (e.g., moqmi with absolute type IDs).
   * @see draft-ietf-moq-loc-01 §2.3 (LOC default)
   */
  extensionParser: ((extensions: Uint8Array | undefined) => LocHeaders) | null = null;

  /**
   * Callback: LOC object routed to pipeline.
   * Called with (mediaType, trackName, object, parsedHeaders).
   * @see draft-ietf-moq-loc-01 §2.3
   */
  onObject:
    | ((
        mediaType: 'video' | 'audio',
        trackName: string,
        obj: MoqtObject,
        headers: LocHeaders,
      ) => void)
    | null = null;

  /**
   * Callback: CMAF object routed to MediaSource adapter.
   * Called with (mediaType, trackName, object). No LOC header parsing.
   * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging)
   */
  onCmafObject:
    | ((
        mediaType: 'video' | 'audio',
        trackName: string,
        obj: MoqtObject,
      ) => void)
    | null = null;

  /**
   * Callback: timeline object received from a mediatimeline track.
   * Called with (trackName, object). No LOC header parsing, no E2EE transform.
   * Payload is a JSON document containing media timeline entries.
   * @see draft-ietf-moq-msf-00 §7 (Media Timeline track)
   */
  onTimelineObject:
    | ((
        trackName: string,
        obj: MoqtObject,
      ) => void)
    | null = null;

  /**
   * Callback: event timeline object received from an eventtimeline track.
   * Called with (trackName, object). No LOC header parsing, no E2EE transform.
   * Payload is a JSON array of event records (§8.1).
   * For CMSF SAP tracks (eventType "org.ietf.moq.cmsf.sap"), the data field
   * contains [sapType, earliestPresentationTimeMs] arrays.
   * @see draft-ietf-moq-msf-00 §8 (Event Timeline track)
   * @see draft-ietf-moq-cmsf-00 §3.6 (SAP Type Timeline)
   */
  onEventTimelineObject:
    | ((
        trackName: string,
        obj: MoqtObject,
      ) => void)
    | null = null;

  /**
   * Callback: init track object received (CMAF initialization segment).
   * Called with (trackName, object). No E2EE transform — init data is not encrypted.
   * Payload contains raw ftyp+moov bytes for MediaSource initialization.
   * @see draft-ietf-moq-cmsf-00 §3.1 (Initialization headers)
   * @see draft-ietf-moq-catalogformat-01 §3.2.16 (initTrack)
   */
  onInitObject:
    | ((
        trackName: string,
        obj: MoqtObject,
      ) => void)
    | null = null;

  /**
   * Callback: malformed track detected.
   * §2.4.2: "When a subscriber detects a Malformed Track, it MUST
   * UNSUBSCRIBE any subscription [...] for that Track from that publisher,
   * and SHOULD deliver an error to the application."
   *
   * Called with (trackAlias, mediaType, trackName, error).
   * @see draft-ietf-moq-transport-16 §2.4.2
   */
  onMalformedTrack:
    | ((
        trackAlias: bigint,
        mediaType: 'video' | 'audio',
        trackName: string,
        error: Error,
      ) => void)
    | null = null;

  /** Number of active track registrations. */
  get activeCount(): number {
    return this.tracks.size;
  }

  /**
   * Register a track alias → media type mapping.
   * Called when SUBSCRIBE_OK returns with a track alias.
   *
   * @param trackAlias The track alias assigned by the publisher
   * @param trackName The MSF track name
   * @param mediaType Whether this is a video, audio, or timeline track
   * @param packaging Container format: 'loc' (default), 'cmaf', 'mediatimeline', or 'eventtimeline'
   * @see draft-ietf-moq-transport-16 §5.1 (SUBSCRIBE_OK includes Track Alias)
   * @see draft-ietf-moq-cmsf-00 §3.5.1 (packaging: "cmaf")
   * @see draft-ietf-moq-msf-00 §8 (eventtimeline packaging)
   */
  registerTrack(
    trackAlias: bigint,
    trackName: string,
    mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline',
    packaging: TrackPackaging = 'loc',
  ): void {
    this.tracks.set(trackAlias, { trackName, mediaType, packaging });
  }

  /**
   * Remove a track alias mapping.
   * Called on PUBLISH_DONE or UNSUBSCRIBE.
   */
  unregisterTrack(trackAlias: bigint): void {
    this.tracks.delete(trackAlias);
  }

  /**
   * Get the media type for a track alias.
   * Returns undefined if the alias is not registered.
   */
  getMediaType(trackAlias: bigint): 'video' | 'audio' | 'mediatimeline' | 'eventtimeline' | undefined {
    return this.tracks.get(trackAlias)?.mediaType;
  }

  /**
   * Route a MoqtObject to the correct pipeline.
   *
   * 1. Look up the track alias
   * 2. Apply objectTransform (E2EE insertion point)
   * 3. Branch on packaging:
   *    - LOC: Parse LOC headers → onObject callback
   *    - CMAF: Skip header parsing → onCmafObject callback
   *    - mediatimeline: raw JSON → onTimelineObject callback
   *    - eventtimeline: raw JSON → onEventTimelineObject callback
   *
   * @param streamId The data stream ID (for logging)
   * @param obj The delivered object from the adapter
   * @see draft-ietf-moq-transport-16 §10.4 (Data Streams)
   * @see draft-ietf-moq-loc-01 §2.3 (LOC Header Extensions)
   * @see draft-ietf-moq-cmsf-00 §3.3 (CMAF Object Packaging)
   * @see draft-ietf-moq-msf-00 §8 (Event Timeline track)
   */
  async routeObject(_streamId: bigint, obj: MoqtObject): Promise<void> {
    const alias = BigInt(obj.trackAlias);
    const info = this.tracks.get(alias);
    if (!info) return; // Unknown track alias — silently ignore

    try {
      // §7: Mediatimeline objects bypass E2EE transform — metadata is not encrypted.
      // Route directly to onTimelineObject with raw JSON payload.
      if (info.packaging === 'mediatimeline') {
        this.onTimelineObject?.(info.trackName, obj);
        return;
      }

      // §8: Eventtimeline objects bypass E2EE transform — metadata is not encrypted.
      // Route directly to onEventTimelineObject with raw JSON payload.
      // @see draft-ietf-moq-msf-00 §8 (Event Timeline track)
      // @see draft-ietf-moq-cmsf-00 §3.6 (SAP Type Timeline)
      if (info.packaging === 'eventtimeline') {
        this.onEventTimelineObject?.(info.trackName, obj);
        return;
      }

      // §3.1: Init track objects bypass E2EE transform — init segments are not encrypted.
      // Route directly to onInitObject with raw ftyp+moov payload.
      if (info.packaging === 'init') {
        this.onInitObject?.(info.trackName, obj);
        return;
      }

      // After metadata track early returns (mediatimeline, eventtimeline, init),
      // mediaType is narrowed to 'video' | 'audio'.
      const mediaType = info.mediaType as 'video' | 'audio';

      // Apply object transform (E2EE decryption, recording, filtering)
      // Supports both sync and async transforms (crypto.subtle.decrypt is async)
      let transformed: MoqtObject | null = obj;
      if (this.objectTransform) {
        const result = this.objectTransform(obj);
        transformed = result instanceof Promise ? await result : result;
        if (!transformed) return; // Transform dropped the object
      }

      if (info.packaging === 'cmaf') {
        // CMAF path: skip LOC header parsing, route directly to MediaSource
        // §3.3: payload contains moof+mdat pairs
        this.onCmafObject?.(mediaType, info.trackName, transformed);
      } else {
        // LOC path: parse extension headers and route to PlaybackPipeline
        const extensions = transformed.kind === 'data' ? transformed.extensions : undefined;
        // Version-aware KVP encoding: draft-14 uses absolute type IDs,
        // draft-16 uses delta-encoded type IDs.
        // @see draft-ietf-moq-transport-14 §1.4.2
        // @see draft-ietf-moq-transport-16 §1.4.2
        const opts: LocHeaderOptions | undefined =
          this.draftVersion === 14 ? { deltaEncoded: false } : undefined;
        const parse = this.extensionParser
          ?? ((ext: Uint8Array | undefined) => parseLocHeaders(ext, opts));
        const headers = parse(extensions);
        this.onObject?.(mediaType, info.trackName, transformed, headers);
      }
    } catch (error) {
      // §2.4.2: Malformed Track — signal to player for UNSUBSCRIBE
      this.onMalformedTrack?.(
        alias,
        info.mediaType as 'video' | 'audio',
        info.trackName,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

