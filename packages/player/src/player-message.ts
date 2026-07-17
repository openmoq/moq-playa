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
import { varint } from '@moqt/transport';
import type { CatalogState, CatalogTrack } from '@moqt/msf';
import type { LoggerLike } from './logger.js';
import type { TrackPackaging } from './subscription-manager.js';

// ─── Types ───────────────────────────────────────────────────────────

/** Active subscription info stored per requestId. */
export interface ActiveSubscription {
  trackName: string;
  trackAlias: bigint;
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
export interface ControlMessageContext {
  adapter: MessageAdapter | null;
  activeSubscriptions: Map<bigint, ActiveSubscription>;
  pendingMediaSubs: Map<bigint, PendingMediaSub>;
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
  onPublishDone?: (requestId: bigint, trackName: string, trackAlias: bigint, statusCode: bigint, errorReason: string) => void;
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
   * Called when SUBSCRIBE_OK assigns a track alias different from the
   * request ID (§9.10). Fetch bookkeeping registered under the optimistic
   * alias (activeFetches, fetchStreamAliases) must follow the remap or a
   * warm-start fetch's objects are orphaned on relays that do not echo
   * the request ID as the alias.
   */
  onMediaAliasRemapped?: (requestId: bigint, oldAlias: bigint, newAlias: bigint) => void;
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

      // Catalog subscription: store the track alias for catalog routing
      if (ctx.catalogRequestId !== null && okReqId === ctx.catalogRequestId) {
        ctx.setCatalogTrackAlias(alias);

        // Evict optimistic media registration if it collides with the catalog alias.
        // knownTracks registers media tracks with requestId as alias BEFORE
        // SUBSCRIBE_OK arrives. If the server assigns the catalog a trackAlias
        // that matches a media track's requestId, catalog objects would be
        // misrouted to the media pipeline (subscriptionManager is checked first
        // in the object routing path). Evicting here ensures catalog objects
        // reach the catalog handler. The media track's own SUBSCRIBE_OK will
        // re-register with the server's actual alias.
        if (ctx.subscriptionManager?.getMediaType(alias) !== undefined) {
          ctx.log.debug('Catalog alias=%s collides with optimistic media registration — evicting', alias);
          ctx.subscriptionManager.unregisterTrack(alias);
        }
      }

      // Media subscriptions: update SubscriptionManager if the server
      // assigned a different track alias than the requestId
      const pending = ctx.pendingMediaSubs.get(okReqId);
      if (pending) {
        ctx.pendingMediaSubs.delete(okReqId);
        if (pending.mediaType === 'video' || pending.mediaType === 'audio') {
          ctx.onMediaSubscribeOk?.(okReqId, pending.trackName, pending.mediaType);
        }
        if (alias !== okReqId) {
          // Server assigned a different alias — check for collision before re-register.
          const existing = ctx.subscriptionManager?.getMediaType(alias);
          if (existing !== undefined) {
            ctx.log.warn('SUBSCRIBE_OK alias collision: alias=%s already registered (type=%s), keeping original for track=%s',
              alias, existing, pending.trackName);
          } else {
            ctx.log.debug('SUBSCRIBE_OK alias remap: reqId=%s → alias=%s track=%s',
              okReqId, alias, pending.trackName);
            ctx.subscriptionManager?.unregisterTrack(okReqId);
            ctx.subscriptionManager?.registerTrack(alias, pending.trackName, pending.mediaType, pending.packaging);
            // Update stored alias for PUBLISH_DONE cleanup
            const active = ctx.activeSubscriptions.get(okReqId);
            if (active) active.trackAlias = alias;
            // Follow the remap in fetch bookkeeping (warm-start joining
            // fetches registered under the optimistic alias).
            ctx.onMediaAliasRemapped?.(okReqId, okReqId, alias);
          }
        }
        // Replay objects that arrived before this alias was resolved
        ctx.onAliasResolved?.(alias);
        // Also replay from the original requestId alias (objects may have
        // arrived on the optimistic alias before the remap)
        if (alias !== okReqId) {
          ctx.onAliasResolved?.(okReqId);
        }
      }
      break;
    }

    case 'PUBLISH_DONE': {
      // §9.15: Publisher is done publishing objects for this subscription.
      // Clean up active subscription state and notify the application.
      const doneReqId = BigInt(msg.requestId);
      const sub = ctx.activeSubscriptions.get(doneReqId);
      ctx.log.debug('PUBLISH_DONE reqId=%s sub=%s', doneReqId, sub ? sub.trackName : '(none)');
      if (sub) {
        ctx.log.info('PUBLISH_DONE "%s": %s', sub.trackName, msg.errorReason ?? '(no reason)');
        ctx.activeSubscriptions.delete(doneReqId);
        ctx.subscriptionManager?.unregisterTrack(sub.trackAlias);

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

      // If the catalog subscription was rejected, clear catalogTrackAlias to
      // prevent track alias collision where media data with the same alias
      // gets misrouted to the catalog handler.
      if (ctx.catalogRequestId !== null && errReqId === ctx.catalogRequestId) {
        ctx.log.warn('Catalog subscription rejected: %s (code=0x%s)',
          msg.errorReason, BigInt(msg.errorCode).toString(16));
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

      // §9.8: REQUEST_ERROR for a media subscription — clean up optimistic
      // state and notify player. The subscribe path optimistically registers
      // activeSubscriptions and SubscriptionManager aliases before SUBSCRIBE_OK;
      // a refusal must undo both.
      const pendingMedia = ctx.pendingMediaSubs.get(errReqId);
      if (pendingMedia && (pendingMedia.mediaType === 'video' || pendingMedia.mediaType === 'audio')) {
        ctx.pendingMediaSubs.delete(errReqId);
        const active = ctx.activeSubscriptions.get(errReqId);
        const alias = active?.trackAlias ?? errReqId;
        ctx.activeSubscriptions.delete(errReqId);
        ctx.subscriptionManager?.unregisterTrack(alias);
        ctx.onMediaSubscribeError?.(errReqId, pendingMedia.trackName, pendingMedia.mediaType,
          msg.errorReason ?? '', BigInt(msg.errorCode));
      }

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
