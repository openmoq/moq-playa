/**
 * Debug logging — leveled, pluggable logger for the player.
 *
 * Human-readable console output for development; pluggable interface
 * for production telemetry. Complementary to qlog (machine-readable
 * protocol tracing per draft-pardue-moq-qlog-moq-events-04).
 *
 * @see DESIGN-production-readiness.md §6 (Debug Logging)
 * @module
 */

// ─── LogLevel ────────────────────────────────────────────────────────

/**
 * Log verbosity level.
 *
 * - `none`: Silent (default for production).
 * - `error`: Only fatal/unrecoverable problems.
 * - `warn`: Recoverable problems that degrade quality.
 * - `info`: Lifecycle milestones (connect, catalog, subscribe).
 * - `debug`: Per-object granularity (very verbose).
 */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

/** Numeric ordering for level comparison. */
export const LOG_LEVELS: Record<LogLevel, number> = {
  none: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

// ─── LoggerLike ──────────────────────────────────────────────────────

/**
 * Logger interface — matches the subset of `console` that we use.
 *
 * Implement this to route logs to custom backends (analytics, telemetry).
 */
export interface LoggerLike {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

// ─── ConsoleLogger ───────────────────────────────────────────────────

/**
 * Default logger — prefixed console output with level gating.
 *
 * hls.js uses a similar pattern (`enableLogs`).
 */
export class ConsoleLogger implements LoggerLike {
  private readonly prefix: string;
  private readonly level: number;

  constructor(level: LogLevel, prefix = 'moqt') {
    this.prefix = prefix;
    this.level = LOG_LEVELS[level];
  }

  error(msg: string, ...args: unknown[]): void {
    if (this.level >= 1) console.error(`[${this.prefix}]`, msg, ...args);
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this.level >= 2) console.warn(`[${this.prefix}]`, msg, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.level >= 3) console.info(`[${this.prefix}]`, msg, ...args);
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.level >= 4) console.debug(`[${this.prefix}]`, msg, ...args);
  }
}

// ─── NULL_LOGGER ─────────────────────────────────────────────────────

/** No-op logger — zero overhead when logging is disabled. */
export const NULL_LOGGER: LoggerLike = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Create a logger from player config.
 *
 * - Custom `logger` provided → return it directly (user controls filtering).
 * - `logLevel` is `'none'` or undefined → return `NULL_LOGGER` (zero overhead).
 * - Otherwise → return `new ConsoleLogger(logLevel)`.
 */
export function createLogger(config: {
  logLevel?: LogLevel;
  logger?: LoggerLike;
}): LoggerLike {
  if (config.logger) return config.logger;
  if (!config.logLevel || config.logLevel === 'none') return NULL_LOGGER;
  return new ConsoleLogger(config.logLevel);
}
