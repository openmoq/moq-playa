/**
 * Error taxonomy — structured error classification for the player.
 *
 * Classifies all errors by severity (transient/degraded/fatal),
 * source (connection/pipeline/decoder/catalog/player/subscription), and numeric code.
 *
 * Error codes use 0x1000+ range to avoid collision with IANA-assigned
 * MOQT error codes (§13.4) which live in 0x0–0xFFF.
 *
 * @see draft-ietf-moq-transport-16 §13.4 (IANA Error Codes)
 * @module
 */

// ─── Severity ─────────────────────────────────────────────────────────

/**
 * How bad is it?
 *
 * - `transient`: Momentary glitch, self-recoverable (e.g., single datagram decode error).
 * - `degraded`: Quality or functionality reduced but playback continues (e.g., data stream reset).
 * - `fatal`: Playback cannot continue (e.g., control stream lost).
 */
export type ErrorSeverity = 'transient' | 'degraded' | 'fatal';

// ─── Source ───────────────────────────────────────────────────────────

/**
 * Where did the error originate?
 *
 * - `connection`: Network/protocol layer (MoqtConnection).
 * - `pipeline`: Playback pipeline (jitter buffer, gap detection, sync).
 * - `decoder`: Browser decoder (WebCodecs VideoDecoder/AudioDecoder).
 * - `catalog`: Catalog parsing (MSF catalog or delta update).
 * - `player`: Player lifecycle (load, destroy, state machine).
 * - `subscription`: Media track subscription refusal.
 */
export type ErrorSource = 'connection' | 'pipeline' | 'decoder' | 'catalog' | 'player' | 'subscription';

// ─── Error Codes ──────────────────────────────────────────────────────

/**
 * Structured error codes in the 0x1000+ range.
 *
 * Organized by source:
 * - 0x1000–0x10FF: Connection errors
 * - 0x1100–0x11FF: Decoder errors
 * - 0x1200–0x12FF: Catalog errors
 * - 0x1300–0x13FF: Player errors
 * - 0x1400–0x14FF: Pipeline errors
 */
export const PlayerErrorCode = {
  // ── Connection (0x1000) ───────────────────────────────────
  /** Control stream lost — session is dead. @see §3.2 */
  CONTROL_STREAM_LOST: 0x1000,
  /** Data stream reset by publisher. @see §10.4 */
  DATA_STREAM_RESET: 0x1001,
  /** Datagram decode error (unreliable, non-fatal). @see §10.3 */
  DATAGRAM_DECODE_ERROR: 0x1002,
  /** WebTransport connection lost. */
  CONNECTION_LOST: 0x1003,
  /** REQUEST_UPDATE failed — forward state change not sent. @see §9.11 */
  REQUEST_UPDATE_FAILED: 0x1004,
  /** Media delivery starved and the restart ladder was exhausted. */
  MEDIA_STARVED: 0x1005,

  // ── Decoder (0x1100) ──────────────────────────────────────
  /** Video decoder error (WebCodecs). */
  VIDEO_DECODE_ERROR: 0x1100,
  /** Audio decoder error (WebCodecs). */
  AUDIO_DECODE_ERROR: 0x1101,
  /**
   * MSE media element wedged beyond recovery (Safari frozen-playhead class):
   * the adapter's nudge/pulse/seek ladder was exhausted — the MediaSource
   * must be rebuilt (fresh tune-in). Fatal.
   */
  MEDIA_ELEMENT_WEDGED: 0x1102,

  // ── Catalog (0x1200) ──────────────────────────────────────
  /** Initial catalog parse failed — cannot proceed. @see MSF §5.1 */
  CATALOG_PARSE_ERROR: 0x1200,
  /** Delta catalog update failed — degraded. @see MSF §5.2 */
  CATALOG_DELTA_ERROR: 0x1201,

  // ── Playback (0x1300) ────────────────────────────────────
  /** Seek failed — timeline lookup or REQUEST_UPDATE error. @see MSF §7 */
  SEEK_FAILED: 0x1300,

  /** Media track subscription failed during load (subscribeToMediaTracks rejection). */
  LOAD_FAILED: 0x1301,
  /** Media track subscription refused by relay (REQUEST_ERROR). @see §9.8 */
  SUBSCRIPTION_REFUSED: 0x1302,
  /** All media track subscriptions refused — no playable content. @see §9.8 */
  ALL_TRACKS_REFUSED: 0x1303,
  // 0x1400 reserved: BUFFER_OVERFLOW (when pipeline backpressure lands)
} as const;

/** Type of a PlayerErrorCode value. */
export type PlayerErrorCodeValue = typeof PlayerErrorCode[keyof typeof PlayerErrorCode];

// ─── PlayerError ──────────────────────────────────────────────────────

/**
 * Structured player error — all errors flow through this type.
 *
 * Application code can switch on `severity` for recovery decisions,
 * `source` for routing to the right handler, and `code` for
 * specific error identification.
 */
export interface PlayerError {
  /** How bad is it? */
  readonly severity: ErrorSeverity;
  /** Where did it come from? */
  readonly source: ErrorSource;
  /** Numeric code for programmatic matching. */
  readonly code: PlayerErrorCodeValue;
  /** Human-readable description. */
  readonly message: string;
  /** Original error, if wrapping. */
  readonly cause?: Error;
  /** When it happened (ms since epoch). */
  readonly timestampMs: number;
  /** Additional context (streamId, errorCode, mediaType, etc.). */
  readonly context?: Record<string, unknown>;
}

// ─── Factory ──────────────────────────────────────────────────────────

/**
 * Create a well-formed PlayerError.
 *
 * Stamps `timestampMs` automatically. Accepts optional `cause` and `context`.
 */
export function createPlayerError(
  severity: ErrorSeverity,
  source: ErrorSource,
  code: PlayerErrorCodeValue,
  message: string,
  options?: { cause?: Error; context?: Record<string, unknown> },
): PlayerError {
  return {
    severity,
    source,
    code,
    message,
    ...(options?.cause ? { cause: options.cause } : {}),
    timestampMs: Date.now(),
    ...(options?.context ? { context: options.context } : {}),
  };
}
