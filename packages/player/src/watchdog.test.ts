/**
 * Tests for WatchdogController — timeout-based diagnostic events.
 *
 * Detects "nothing happened" scenarios by setting expectations
 * for events that should arrive within a deadline.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatchdogController } from './watchdog.js';

describe('WatchdogController', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits timeout when expected event does not arrive', () => {
    const onTimeout = vi.fn();
    const wd = new WatchdogController({ onTimeout });

    wd.expect('catalog_received', 5000);
    vi.advanceTimersByTime(5000);

    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'catalog_received',
        timeoutMs: 5000,
      }),
    );
  });

  it('does not emit timeout when fulfilled before deadline', () => {
    const onTimeout = vi.fn();
    const wd = new WatchdogController({ onTimeout });

    wd.expect('catalog_received', 5000);
    wd.fulfill('catalog_received');
    vi.advanceTimersByTime(5000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('emits warning at 50% of timeout', () => {
    const onWarning = vi.fn();
    const wd = new WatchdogController({ onWarning });

    wd.expect('first_media_object', 10000);
    vi.advanceTimersByTime(5000);

    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'first_media_object',
        elapsedMs: 5000,
        timeoutMs: 10000,
      }),
    );
  });

  it('warning does not fire if fulfilled before 50%', () => {
    const onWarning = vi.fn();
    const wd = new WatchdogController({ onWarning });

    wd.expect('catalog_received', 10000);
    wd.fulfill('catalog_received');
    vi.advanceTimersByTime(5000);

    expect(onWarning).not.toHaveBeenCalled();
  });

  it('multiple expectations are independent', () => {
    const onTimeout = vi.fn();
    const wd = new WatchdogController({ onTimeout });

    wd.expect('catalog_received', 3000);
    wd.expect('first_media_object', 8000);

    wd.fulfill('catalog_received');
    vi.advanceTimersByTime(8000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_media_object' }),
    );
  });

  it('re-expecting the same event resets the timer', () => {
    const onTimeout = vi.fn();
    const wd = new WatchdogController({ onTimeout });

    wd.expect('catalog_received', 3000);
    vi.advanceTimersByTime(2000);
    wd.expect('catalog_received', 3000); // reset
    vi.advanceTimersByTime(2000);

    expect(onTimeout).not.toHaveBeenCalled(); // only 2s into second timer

    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('destroy cancels all pending timers', () => {
    const onTimeout = vi.fn();
    const wd = new WatchdogController({ onTimeout });

    wd.expect('catalog_received', 3000);
    wd.expect('first_media_object', 5000);
    wd.destroy();

    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('activeExpectations returns pending event names', () => {
    const wd = new WatchdogController({});

    wd.expect('catalog_received', 3000);
    wd.expect('first_media_object', 5000);

    expect(wd.activeExpectations).toEqual(
      expect.arrayContaining(['catalog_received', 'first_media_object']),
    );

    wd.fulfill('catalog_received');
    expect(wd.activeExpectations).toEqual(['first_media_object']);
  });
});
