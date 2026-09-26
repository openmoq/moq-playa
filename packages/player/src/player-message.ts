/**
 * Control message routing + catalog object handling — extracted from MoqtPlayer.
 *
 * Pure functions that take explicit context parameters. No class state.
 *
 * @see draft-ietf-moq-transport-16 §9.4 (GOAWAY)
 * @see draft-ietf-moq-transport-16 §9.10 (SUBSCRIBE_OK)
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 * @see draft-ietf-moq-transport-16 §9.7 (REQUEST_OK)
 * @see draft-ietf-moq-transport-16 §9.8 (REQUEST_ERROR)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @module
 */

import type { ControlMessage, Parameters } from '@moqt/transport';
import { varint, readLocation, MessageParam } from '@moqt/transport';
import type { CatalogState, CatalogTrack } from '@moqt/msf';
import type { LoggerLike } from './logger.js';
import type { TrackPackaging } from './subscription-manager.js';

// ─── Types ───────────────────────────────────────────────────────────

/** Active subscription info stored per requestId. */
export interface ActiveSubscription {
  trackName: string;
  /** Unknown until SUBSCRIBE_OK; a Request ID is never an alias. */
  trackAlias: bigint | null;
}

/** Pending media subscription info stored per requestId. */
export interface PendingMediaSub {
  trackName: string;
  mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline';
  packaging?: TrackPackaging;
}

/** Pending track status promise handles. */
export interface PendingTrackStatus {
  resolve: (result: { requestId: bigint; parameters: Parameters }) => void;
  reject: (error: Error) => void;
}

/** Minimal adapter interface for message handling. */
export interface MessageAdapter {
  unsubscribe(requestId: ReturnType<typeof varint>): void;
}

/** Minimal subscription manager interface. */
export interface MessageSubscriptionManager {
  unregisterTrack(trackAlias: bigint): void;
  registerTrack(trackAlias: bigint, trackName: string, mediaType: 'video' | 'audio' | 'mediatimeline' | 'eventtimeline', packaging?: TrackPackaging): void;
  /** Check if a track alias is already registered. */
  getMediaType(trackAlias: bigint): 'video' | 'audio' | 'mediatimeline' | 'eventtimeline' | undefined;
}

/** Context for handleControlMessage. */
/**
 * Extract the LARGEST_OBJECT Location from SUBSCRIBE_OK parameters.
 * d14/16 encode it as a raw Location byte blob (§9.2.2.7); the d18 codec
 * decodes location-kind parameters into a typed {group, object}. Absent or
 * malformed = null (track empty at subscribe time).
 */
function extractLargestLocation(parameters: Parameters | undefined): { group: bigint; object: bigint } | null {
  const raw = parameters?.get(MessageParam.LARGEST_OBJECT)?.[0];
  if (raw instanceof Uint8Array) {
    try {
      const { value } = readLocation(raw, 0);
      return { group: BigInt(value.group), object: BigInt(value.object) };
    } catch { return null; }
  }
  if (raw !== undefined && raw !== null && typeof raw === 'object'
      && 'group' in (raw as object) && 'object' in (raw as object)) {
    const loc = raw as { group: bigint | number; object: bigint | number };
    return { group: BigInt(loc.group), object: BigInt(loc.object) };
  }
  return null;
}

export interface ControlMessageContext {
  /** Catalog bootstrap: SUBSCRIBE_OK largest for the catalog subscription
   *  (null = SUBSCRIBE_OK carried no LARGEST_OBJECT → track empty). */
  onCatalogSubscribeOk?: (largest: { group: bigint; object: bigint } | null) => void;
  /** Staged recovery: SUBSCRIBE_OK for the CANDIDATE catalog subscription.
   *  Returns true when consumed (transaction-local — never the main slot). */
  onRecoveryCatalogSubscribeOk?: (reqId: bigint, alias: bigint, largest: { group: bigint; object: bigint } | null) => boolean;
  /** Staged recovery: PUBLISH_DONE for the CANDIDATE subscription. */
  onRecoveryCatalogPublishDone?: (reqId: bigint, statusCode: bigint) => boolean;
  /** Staged recovery: REQUEST_ERROR for the CANDIDATE subscription. */
  onRecoveryCatalogRequestError?: (reqId: bigint) => boolean;
  /** Catalog bootstrap: FETCH_OK for the bootstrap fetch. */
  onCatalogBootstrapFetchOk?: (requestId: bigint, endLocation: { group: bigint; object: bigint }, endOfTrack: boolean) => void;
  /** Catalog bootstrap: REQUEST_ERROR for the bootstrap fetch. */
  onCatalogBootstrapFetchError?: (requestId: bigint, errorCode: bigint) => void;
  /** Catalog bootstrap: PUBLISH_DONE on the catalog subscription (raw status). */
  onCatalogPublishDone?: (statusCode: bigint) => void;
  /** The catalog SUBSCRIBE itself was refused (REQUEST_ERROR on `catalogRequestId`). */
  onCatalogSubscribeError?: (errorCode: bigint, errorReason: string) => void;
  adapter: MessageAdapter | null;
  activeSubscriptions: Map<bigint, ActiveSubscription>;
  pendingMediaSubs: Map<bigint, PendingMediaSub>;
  removeSubscription: (requestId: bigint) => ActiveSubscription | undefined;
  pendingTrackStatuses: Map<bigint, PendingTrackStatus>;
  catalogRequestId: bigint | null;
  catalogTrackAlias: bigint | null;
  subscriptionManager: MessageSubscriptionManager | null;
  log: LoggerLike;
  emitEvent: (event: Record<string, unknown>) => void;
  setCatalogTrackAlias: (alias: bigint) => void;
  clearCatalogState: () => void;
  onGoaway: (newSessionUri: string | undefined) => void;
  /** Called when SUBSCRIBE_OK resolves an alias — replay buffered objects. */
  onAliasResolved?: (alias: bigint) => void;
  /** Called when SUBSCRIBE_OK matches a pending media subscription. @see §9.10 */
  onMediaSubscribeOk?: (requestId: bigint, trackName: string, mediaType: 'video' | 'audio') => void;
  /** Called when REQUEST_ERROR matches a pending media subscription. @see §9.8 */
  onMediaSubscribeError?: (requestId: bigint, trackName: string, mediaType: 'video' | 'audio', reason: string, errorCode: bigint) => void;
  /** Called when PUBLISH_DONE arrives — player can re-subscribe if needed. */
  onPublishDone?: (requestId: bigint, trackName: string, trackAlias: bigint | null, statusCode: bigint, errorReason: string) => void;
  /**
   * Called when REQUEST_ERROR matches a pending fetchCatalog. The
   * player layer dispatches the error to the right pending promise.
   * Same shape as the inline pendingTrackStatuses handler — kept as a
   * callback so player-message.ts doesn't need to import CatalogState.
   */
  onCatalogFetchError?: (requestId: bigint, errorReason: string, errorCode: bigint) => void;
  /**
   * Called when REQUEST_ERROR matches an active media FETCH (e.g. a
   * warm-start joining fetch, §9.16.2). Never fatal: the player logs and
   * continues live-only. The message layer only reports; the player owns
   * the activeFetches cleanup.
   */
  onMediaFetchError?: (requestId: bigint, errorReason: string, errorCode: bigint) => void;
  /**
   * Called after SUBSCRIBE_OK binds the alias. Joining FETCH data waiting
   * for this subscription can now be delivered, even when alias == requestId.
   */
  onMediaAliasBound?: (requestId: bigint, alias: bigint) => void;
}

/** Retire only routing owned by this request, never by its numeric ID. */
export function removeSubscription(
  requestId: bigint,
  ctx: Pick<ControlMessageContext, 'activeSubscriptions' | 'pendingMediaSubs' | 'subscriptionManager'>,
): ActiveSubscription | undefined {
  const sub = ctx.activeSubscriptions.get(requestId);
  ctx.activeSubscriptions.delete(requestId);
  ctx.pendingMediaSubs.delete(requestId);
  if (sub?.trackAlias != null
      && ![...ctx.activeSubscriptions.values()].some((other) => other.trackAlias === sub.trackAlias)) {
    ctx.subscriptionManager?.unregisterTrack(sub.trackAlias);
  }
  return sub;
}

/** Known tracks config (subset of MoqtPlayerConfig.knownTracks). */
export interface KnownTracksConfig {
  video?: { name: string; codec?: string };
  audio?: { name: string; codec?: string };
}

// ─── handleControlMessage ───────────────────────────────────────────

/**
 * Route a control message to the appropriate handler.
 *
 * Only handles messages that need application-level action —
 * other message types are handled by the session state machine
 * in the adapter.
 *
 * @see draft-ietf-moq-transport-16 §9.4 (GOAWAY)
 * @see draft-ietf-moq-transport-16 §9.10 (SUBSCRIBE_OK)
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 * @see draft-ietf-moq-transport-16 §9.7 (REQUEST_OK)
 * @see draft-ietf-moq-transport-16 §9.8 (REQUEST_ERROR)
 */
export function handleControlMessage(
  msg: ControlMessage,
  ctx: ControlMessageContext,
): void {
  // DEBUG: trace control messages
  if (typeof console !== 'undefined') {
    const reqId = 'requestId' in msg ? msg.requestId : undefined;
    const reqStr = reqId !== undefined ? String(reqId) : 'N/A';
    const sub = reqId !== undefined ? ctx.activeSubscriptions.get(BigInt(reqId)) : undefined;
    const trackStr = sub ? ` track=${sub.trackName}` : '';
    const extra = msg.type === 'SUBSCRIBE_OK' ? ` alias=${String((msg as any).trackAlias)}` :
      msg.type === 'PUBLISH_DONE' ? ` reason="${(msg as any).errorReason ?? ''}"` :
      msg.type === 'REQUEST_ERROR' ? ` code=0x${BigInt((msg as any).errorCode).toString(16)} reason="${(msg as any).errorReason ?? ''}"` : '';
    ctx.log.debug('[CTRL] %s reqId=%s%s%s', msg.type, reqStr, trackStr, extra);
  }
  switch (msg.type) {
    case 'GOAWAY':
      ctx.log.info('GOAWAY received, uri=%s', msg.newSessionUri ?? '(none)');
      // §9.4 SHOULD: "A subscriber SHOULD individually UNSUBSCRIBE for
      // each existing subscription"
      for (const [requestId] of ctx.activeSubscriptions) {
        ctx.adapter?.unsubscribe(varint(requestId));
      }
      ctx.activeSubscriptions.clear();

      ctx.emitEvent({
        type: 'session_goaway',
        newSessionUri: msg.newSessionUri,
      });

      // §3.5, §8.4.1: Delegate migration to player
      ctx.onGoaway(msg.newSessionUri);
      break;

    case 'SUBSCRIBE_OK': {
      // §9.10: SUBSCRIBE_OK assigns the server's Track Alias for this subscription.
      // Data objects carry trackAlias (not requestId), so we must store
      // this mapping for correct object routing.
      const okReqId = BigInt(msg.requestId);
      const alias = BigInt(msg.trackAlias);
      ctx.log.debug('SUBSCRIBE_OK reqId=%s alias=%s', okReqId, alias);

      // Staged recovery candidate: transaction-local — consumed here, never
      // touching the main catalog slot.
      if (ctx.onRecoveryCatalogSubscribeOk?.(okReqId, alias, extractLargestLocation(msg.parameters as Parameters | undefined))) {
        break;
      }

      // Catalog subscription: store the track alias for catalog routing
      if (ctx.catalogRequestId !== null && okReqId === ctx.catalogRequestId) {
        // Catalog bootstrap: the LARGEST_OBJECT location (§9.2.2.7 / d18
        // largest) anchors the joined group and the rung-1 emulation range —
        // it MUST be installed BEFORE the alias bind below, because binding
        // replays parked objects and an older parked independent judged
        // against largest === null could wrongly supersede the Joining FETCH.
        // Absent parameter = track empty at subscribe time.
        if (ctx.onCatalogSubscribeOk) {
          ctx.onCatalogSubscribeOk(extractLargestLocation(msg.parameters as Parameters | undefined));
        }
        ctx.setCatalogTrackAlias(alias);
      }

      // The session has validated alias uniqueness. Only its confirmed
      // binding may enter the data routing table (draft-18 section 11.1).
      const pending = ctx.pendingMediaSubs.get(okReqId);
      const active = ctx.activeSubscriptions.get(okReqId);
      if (pending && active) {
        ctx.pendingMediaSubs.delete(okReqId);
        active.trackAlias = alias;
        ctx.subscriptionManager?.registerTrack(alias, pending.trackName, pending.mediaType, pending.packaging);
        if (pending.mediaType === 'video' || pending.mediaType === 'audio') {
          ctx.onMediaSubscribeOk?.(okReqId, pending.trackName, pending.mediaType);
        }
        ctx.onMediaAliasBound?.(okReqId, alias);
        // Replay objects that arrived before this alias was resolved
        ctx.onAliasResolved?.(alias);
      }
      break;
    }

    case 'FETCH_OK': {
      // §9.16/§10.12: only the catalog bootstrap consumes FETCH_OK today (it
      // fixes the prefix's exclusive end; completion still requires the data
      // FIN). Media fetches rely on the stream FIN alone, as before.
      const okId = BigInt((msg as { requestId: bigint }).requestId);
      const end = (msg as { endLocation?: { group: bigint; object: bigint } }).endLocation;
      if (end !== undefined) {
        ctx.onCatalogBootstrapFetchOk?.(okId,
          { group: BigInt(end.group), object: BigInt(end.object) },
          Boolean((msg as { endOfTrack?: number }).endOfTrack));
      }
      break;
    }

    case 'PUBLISH_DONE': {
      // §9.15: Publisher is done publishing objects for this subscription.
      // Clean up active subscription state and notify the application.
      const doneReqId = BigInt(msg.requestId);

      // Staged recovery candidate: transaction-local.
      if (ctx.onRecoveryCatalogPublishDone?.(doneReqId, BigInt(msg.statusCode))) {
        break;
      }

      // Catalog subscription: status-aware handling is the bootstrap
      // coordinator's (normalized per-draft player-side). PUBLISH_DONE is NOT
      // a delivery barrier — the adapter's terminal drain keeps delivering
      // late objects; drained finalizes.
      if (ctx.catalogRequestId !== null && doneReqId === ctx.catalogRequestId) {
        ctx.onCatalogPublishDone?.(BigInt(msg.statusCode));
        break;
      }
      const sub = ctx.activeSubscriptions.get(doneReqId);
      ctx.log.debug('PUBLISH_DONE reqId=%s sub=%s', doneReqId, sub ? sub.trackName : '(none)');
      if (sub) {
        ctx.log.info('PUBLISH_DONE "%s": %s', sub.trackName, msg.errorReason ?? '(no reason)');
        ctx.removeSubscription(doneReqId);

        // Let the player re-subscribe if this is a track we still want
        if (ctx.onPublishDone) {
          ctx.onPublishDone(doneReqId, sub.trackName, sub.trackAlias, BigInt(msg.statusCode), msg.errorReason ?? '');
        } else {
          ctx.emitEvent({
            type: 'track_unsubscribed',
            trackName: sub.trackName,
            reason: msg.errorReason ?? '',
          });
        }
      }
      break;
    }

    case 'REQUEST_OK': {
      // §9.7: REQUEST_OK for a TRACK_STATUS query — resolve the promise.
      const okReqId = BigInt(msg.requestId);
      const pendingStatus = ctx.pendingTrackStatuses.get(okReqId);
      if (pendingStatus) {
        ctx.pendingTrackStatuses.delete(okReqId);
        pendingStatus.resolve({
          requestId: okReqId,
          parameters: msg.parameters,
        });
      }
      break;
    }

    case 'REQUEST_ERROR': {
      const errReqId = BigInt(msg.requestId);

      // Staged recovery candidate SUBSCRIBE refused → candidate fails
      // (transaction-local; the active catalog is untouched).
      if (ctx.onRecoveryCatalogRequestError?.(errReqId)) {
        break;
      }

      // If the catalog subscription was rejected, clear catalogTrackAlias to
      // prevent track alias collision where media data with the same alias
      // gets misrouted to the catalog handler.
      if (ctx.catalogRequestId !== null && errReqId === ctx.catalogRequestId) {
        ctx.log.warn('Catalog subscription rejected: %s (code=0x%s)',
          msg.errorReason, BigInt(msg.errorCode).toString(16));
        ctx.onCatalogSubscribeError?.(BigInt(msg.errorCode), msg.errorReason ?? '');
        ctx.clearCatalogState();
      }

      // §9.8: REQUEST_ERROR for a TRACK_STATUS query — reject the promise.
      const pendingErr = ctx.pendingTrackStatuses.get(errReqId);
      if (pendingErr) {
        ctx.pendingTrackStatuses.delete(errReqId);
        pendingErr.reject(new Error(
          `TRACK_STATUS failed: ${msg.errorReason} (code=0x${BigInt(msg.errorCode).toString(16)})`,
        ));
      }

      // A refused pending subscription has no alias to unregister.
      const pendingMedia = ctx.pendingMediaSubs.get(errReqId);
      if (pendingMedia) {
        ctx.removeSubscription(errReqId);
        if (pendingMedia.mediaType === 'video' || pendingMedia.mediaType === 'audio') {
          ctx.onMediaSubscribeError?.(errReqId, pendingMedia.trackName, pendingMedia.mediaType,
            msg.errorReason ?? '', BigInt(msg.errorCode));
        }
      }

      // Catalog-bootstrap fetch: INVALID_RANGE (empty track) vs any other
      // refusal — the coordinator's ladder decides.
      ctx.onCatalogBootstrapFetchError?.(errReqId, BigInt(msg.errorCode));

      // §9.8: REQUEST_ERROR for a fetchCatalog FETCH — dispatch to the
      // pending promise via the player-side callback.
      ctx.onCatalogFetchError?.(errReqId, msg.errorReason, BigInt(msg.errorCode));

      // §9.8: REQUEST_ERROR for an active media FETCH (warm-start joining
      // fetch or manual media fetch) — non-fatal; the player cleans up its
      // fetch bookkeeping and continues live-only.
      ctx.onMediaFetchError?.(errReqId, msg.errorReason, BigInt(msg.errorCode));
      break;
    }

    // Other message types are handled by the session state machine
    // in the adapter. The player only handles messages that need
    // application-level action.
  }
}

// ─── validateKnownTracks ────────────────────────────────────────────

/**
 * Validate pre-known tracks against the actual catalog.
 *
 * Logs warnings on mismatches — the user provided knownTracks that don't
 * match the broadcast. Playback continues with the pre-known config.
 *
 * @see DESIGN-production-readiness.md §2 (TTFF optimization)
 */
export function validateKnownTracks(
  knownTracks: KnownTracksConfig,
  catalog: CatalogState,
  log: LoggerLike,
): void {
  if (knownTracks.video) {
    const videoTrack = catalog.tracks.find((t: CatalogTrack) => t.name === knownTracks.video!.name);
    if (!videoTrack) {
      log.warn('knownTracks: video track "%s" not found in catalog', knownTracks.video.name);
    } else if (videoTrack.codec && knownTracks.video.codec !== videoTrack.codec) {
      log.warn('knownTracks: video codec mismatch — known="%s" catalog="%s"',
        knownTracks.video.codec, videoTrack.codec);
    }
  }

  if (knownTracks.audio) {
    const audioTrack = catalog.tracks.find((t: CatalogTrack) => t.name === knownTracks.audio!.name);
    if (!audioTrack) {
      log.warn('knownTracks: audio track "%s" not found in catalog', knownTracks.audio.name);
    } else if (audioTrack.codec && knownTracks.audio.codec !== audioTrack.codec) {
      log.warn('knownTracks: audio codec mismatch — known="%s" catalog="%s"',
        knownTracks.audio.codec, audioTrack.codec);
    }
  }
}
