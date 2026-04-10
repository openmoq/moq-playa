/**
 * Debug logging tests — LoggerLike, ConsoleLogger, NULL_LOGGER, createLogger.
 *
 * @see DESIGN-production-readiness.md §6 (Debug Logging)
 * @module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConsoleLogger,
  NULL_LOGGER,
  LOG_LEVELS,
  createLogger,
  type LogLevel,
  type LoggerLike,
} from './logger.js';

describe('Debug Logging', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── LOG_LEVELS ────────────────────────────────────────────────

  it('LOG_LEVELS numeric ordering: none < error < warn < info < debug', () => {
    expect(LOG_LEVELS.none).toBe(0);
    expect(LOG_LEVELS.error).toBe(1);
    expect(LOG_LEVELS.warn).toBe(2);
    expect(LOG_LEVELS.info).toBe(3);
    expect(LOG_LEVELS.debug).toBe(4);
    // Strict ordering
    expect(LOG_LEVELS.none).toBeLessThan(LOG_LEVELS.error);
    expect(LOG_LEVELS.error).toBeLessThan(LOG_LEVELS.warn);
    expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.info);
    expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.debug);
  });

  // ── ConsoleLogger level gating ────────────────────────────────

  it('ConsoleLogger at level "error" only calls console.error', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const log = new ConsoleLogger('error');
    log.error('test');
    log.warn('test');
    log.info('test');
    log.debug('test');

    expect(spyError).toHaveBeenCalledTimes(1);
    expect(spyWarn).not.toHaveBeenCalled();
    expect(spyInfo).not.toHaveBeenCalled();
    expect(spyDebug).not.toHaveBeenCalled();
  });

  it('ConsoleLogger at level "warn" calls error + warn, not info/debug', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const log = new ConsoleLogger('warn');
    log.error('test');
    log.warn('test');
    log.info('test');
    log.debug('test');

    expect(spyError).toHaveBeenCalledTimes(1);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyInfo).not.toHaveBeenCalled();
    expect(spyDebug).not.toHaveBeenCalled();
  });

  it('ConsoleLogger at level "info" calls error + warn + info, not debug', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const log = new ConsoleLogger('info');
    log.error('test');
    log.warn('test');
    log.info('test');
    log.debug('test');

    expect(spyError).toHaveBeenCalledTimes(1);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyInfo).toHaveBeenCalledTimes(1);
    expect(spyDebug).not.toHaveBeenCalled();
  });

  it('ConsoleLogger at level "debug" calls all four', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const log = new ConsoleLogger('debug');
    log.error('test');
    log.warn('test');
    log.info('test');
    log.debug('test');

    expect(spyError).toHaveBeenCalledTimes(1);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyInfo).toHaveBeenCalledTimes(1);
    expect(spyDebug).toHaveBeenCalledTimes(1);
  });

  it('ConsoleLogger at level "none" calls nothing', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const log = new ConsoleLogger('none');
    log.error('test');
    log.warn('test');
    log.info('test');
    log.debug('test');

    expect(spyError).not.toHaveBeenCalled();
    expect(spyWarn).not.toHaveBeenCalled();
    expect(spyInfo).not.toHaveBeenCalled();
    expect(spyDebug).not.toHaveBeenCalled();
  });

  // ── ConsoleLogger prefix ──────────────────────────────────────

  it('ConsoleLogger prefixes messages with [moqt]', () => {
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = new ConsoleLogger('info');
    log.info('Session established');
    expect(spyInfo).toHaveBeenCalledWith('[moqt]', 'Session established');
  });

  it('ConsoleLogger custom prefix', () => {
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = new ConsoleLogger('info', 'myapp');
    log.info('hello');
    expect(spyInfo).toHaveBeenCalledWith('[myapp]', 'hello');
  });

  // ── ConsoleLogger passes through extra args ───────────────────

  it('ConsoleLogger passes through extra args', () => {
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const log = new ConsoleLogger('info');
    log.info('tracks=%d', 3);
    expect(spyInfo).toHaveBeenCalledWith('[moqt]', 'tracks=%d', 3);
  });

  // ── NULL_LOGGER ───────────────────────────────────────────────

  it('NULL_LOGGER calls nothing', () => {
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    NULL_LOGGER.error('test');
    NULL_LOGGER.warn('test');
    NULL_LOGGER.info('test');
    NULL_LOGGER.debug('test');

    expect(spyError).not.toHaveBeenCalled();
    expect(spyWarn).not.toHaveBeenCalled();
    expect(spyInfo).not.toHaveBeenCalled();
    expect(spyDebug).not.toHaveBeenCalled();
  });

  // ── createLogger ──────────────────────────────────────────────

  it('createLogger with no config returns NULL_LOGGER', () => {
    const log = createLogger({});
    expect(log).toBe(NULL_LOGGER);
  });

  it('createLogger with logLevel "none" returns NULL_LOGGER', () => {
    const log = createLogger({ logLevel: 'none' });
    expect(log).toBe(NULL_LOGGER);
  });

  it('createLogger with custom logger returns that logger', () => {
    const custom: LoggerLike = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const log = createLogger({ logger: custom });
    expect(log).toBe(custom);
  });

  it('createLogger with logLevel "info" returns a ConsoleLogger', () => {
    const log = createLogger({ logLevel: 'info' });
    expect(log).toBeInstanceOf(ConsoleLogger);
  });
});
