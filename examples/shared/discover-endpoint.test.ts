/**
 * Tests for the discovery engine: staggered starts, deterministic selection,
 * bounded attempts, real teardown, containment of late settlements.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverEndpoint, EndpointDiscoveryError } from './discover-endpoint.js';
import type { ProbeSession } from './probe-transport.js';

// ─── Controllable connect fake ──────────────────────────────────────

interface FakeAttempt {
  url: string;
  signal: AbortSignal;
  abortFired: boolean;
  closeCalls: number;
  succeed: () => void;
  fail: (err?: unknown) => void;
}

let attempts: FakeAttempt[];

function makeConnect(): (url: string, signal: AbortSignal) => Promise<ProbeSession> {
  attempts = [];
  return (url, signal) => new Promise<ProbeSession>((resolve, reject) => {
    const attempt: FakeAttempt = {
      url,
      signal,
      abortFired: false,
      closeCalls: 0,
      succeed: () => resolve({ close: () => { attempt.closeCalls++; } }),
      fail: (err?: unknown) => reject(err ?? new Error(`refused: ${url}`)),
    };
    signal.addEventListener('abort', () => {
      attempt.abortFired = true;
      reject(signal.reason);
    }, { once: true });
    attempts.push(attempt);
  });
}

const CANDIDATES = [
  'https://h:4433/moq',
  'https://h:4433/moq-relay',
  'https://h:4433/',
] as const;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  vi.useFakeTimers();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

/** Flush microtasks under fake timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('discoverEndpoint selection', () => {
  it('resolves to the first candidate and never starts another when it succeeds fast', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    attempts[0]!.succeed();
    await expect(discovery).resolves.toBe(CANDIDATES[0]);
    expect(attempts).toHaveLength(1);
  });

  it('closes the winning session and returns only the URL', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    attempts[0]!.succeed();
    await discovery;
    expect(attempts[0]!.closeCalls).toBe(1);
  });

  it('falls back to the second candidate when the first rejects', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    attempts[0]!.fail();
    await flush();
    expect(attempts).toHaveLength(2);
    attempts[1]!.succeed();
    await expect(discovery).resolves.toBe(CANDIDATES[1]);
  });

  it('falls back to the third candidate when the first two reject', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    attempts[0]!.fail();
    await flush();
    attempts[1]!.fail();
    await flush();
    expect(attempts.map((a) => a.url)).toEqual([...CANDIDATES]);
    attempts[2]!.succeed();
    await expect(discovery).resolves.toBe(CANDIDATES[2]);
  });

  it('starts the next candidate after the stagger delay while the first is still pending', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(799);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(2);
    attempts[0]!.succeed();
    await expect(discovery).resolves.toBe(CANDIDATES[0]);
  });

  it('a held lower-priority success stops further candidate starts', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    await vi.advanceTimersByTimeAsync(800);       // candidate 2 starts
    expect(attempts).toHaveLength(2);
    attempts[1]!.succeed();                        // held: candidate 1 still pending
    await flush();
    await vi.advanceTimersByTimeAsync(800);       // would be candidate 3's start
    expect(attempts).toHaveLength(2);              // never launched
    attempts[0]!.fail();
    await expect(discovery).resolves.toBe(CANDIDATES[1]);
  });

  it('holds a lower-priority success as {url} only — its session closes at success time', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    await vi.advanceTimersByTimeAsync(800);
    attempts[1]!.succeed();
    await flush();
    // Closed immediately, BEFORE the priority decision resolves.
    expect(attempts[1]!.closeCalls).toBe(1);
    attempts[0]!.fail();
    await expect(discovery).resolves.toBe(CANDIDATES[1]);
    expect(attempts[1]!.closeCalls).toBe(1);
  });

  it('selects the higher-priority candidate when it succeeds after a held lower-priority success', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    await vi.advanceTimersByTimeAsync(800);
    attempts[1]!.succeed();                        // held
    await flush();
    attempts[0]!.succeed();                        // higher priority wins
    await expect(discovery).resolves.toBe(CANDIDATES[0]);
    expect(attempts[0]!.closeCalls).toBe(1);
    expect(attempts[1]!.closeCalls).toBe(1);
  });
});

describe('discoverEndpoint failure', () => {
  it('throws EndpointDiscoveryError naming every attempted URL when all candidates fail', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    const pending = expect(discovery).rejects.toThrow(EndpointDiscoveryError);
    await flush();
    attempts[0]!.fail();
    await flush();
    attempts[1]!.fail();
    await flush();
    attempts[2]!.fail();
    await pending;
    const err = await discovery.catch((e: unknown) => e) as EndpointDiscoveryError;
    expect(err.message).toContain('No MoQ relay endpoint found');
    expect(err.message).toContain('retry');
    for (const url of CANDIDATES) expect(err.message).toContain(url);
    expect(err.attempts.map((a) => a.url)).toEqual([...CANDIDATES]);
    expect(err.attempts.every((a) => a.outcome === 'failed')).toBe(true);
  });

  it('never silently resolves to /moq on total failure', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    const outcome = discovery.then(() => 'resolved', () => 'rejected');
    await flush();
    for (const a of [...attempts]) a.fail();
    await flush();
    attempts[1]?.fail();
    await flush();
    attempts[2]?.fail();
    await flush();
    await expect(outcome).resolves.toBe('rejected');
  });
});

describe('discoverEndpoint bounds and teardown', () => {
  it('aborts a hung attempt at the attempt timeout (real teardown, not abandonment)', async () => {
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts[0]!.abortFired).toBe(true);
    // Later candidates proceed.
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    attempts[1]!.succeed();
    await expect(discovery).resolves.toBe(CANDIDATES[1]);
  });

  it('records timed-out attempts as timeout in the failure report', async () => {
    const discovery = discoverEndpoint({ candidates: [CANDIDATES[0]], connect: makeConnect() });
    const pending = expect(discovery).rejects.toThrow(EndpointDiscoveryError);
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    const err = await discovery.catch((e: unknown) => e) as EndpointDiscoveryError;
    expect(err.attempts).toEqual([{ url: CANDIDATES[0], outcome: 'timeout' }]);
  });

  it('closes a late success materializing on a torn-down attempt', async () => {
    let resolveLate!: (s: ProbeSession) => void;
    const closeCalls = { count: 0 };
    const connect = (url: string, _signal: AbortSignal): Promise<ProbeSession> => {
      if (url === CANDIDATES[0]) {
        // Ignores its abort signal entirely — worst-case connector.
        return new Promise<ProbeSession>((res) => { resolveLate = res; });
      }
      return Promise.resolve({ close: () => {} });
    };
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect });
    await flush();
    await vi.advanceTimersByTimeAsync(2000);       // candidate 1 timed out; candidate 2 already up
    await expect(discovery).resolves.toBe(CANDIDATES[1]);
    resolveLate({ close: () => { closeCalls.count++; } });
    await flush();
    expect(closeCalls.count).toBe(1);
  });

  it('aborts still-pending lower-priority attempts when a higher-priority success settles', async () => {
    // /moq-relay hangs after the stagger start; /moq then succeeds. The
    // settled discovery must tear the hung probe down, not leave it open.
    const discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    await vi.advanceTimersByTimeAsync(800);        // candidate 2 starts, hangs
    expect(attempts).toHaveLength(2);
    attempts[0]!.succeed();                         // candidate 1 wins
    await expect(discovery).resolves.toBe(CANDIDATES[0]);
    expect(attempts[1]!.abortFired).toBe(true);     // hung probe torn down
  });

  it('aborts still-pending attempts when total failure settles', async () => {
    // Candidate 3 hangs while 1 and 2 fail; candidate 3's timeout concludes
    // the discovery — but if a connector ignores its timeout-abort, the
    // finish path itself must still have fired every pending controller.
    const discovery = discoverEndpoint({
      candidates: [CANDIDATES[0], CANDIDATES[1]], connect: makeConnect(),
    });
    const pending = expect(discovery).rejects.toThrow(EndpointDiscoveryError);
    await flush();
    attempts[0]!.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);        // candidate 2 times out
    await pending;
    expect(attempts[1]!.abortFired).toBe(true);
  });

  it('aborts every in-flight attempt and rejects with the reason on discovery-level abort', async () => {
    const controller = new AbortController();
    const reason = new Error('discovery cancelled');
    const discovery = discoverEndpoint({
      candidates: CANDIDATES, connect: makeConnect(), signal: controller.signal,
    });
    const pending = expect(discovery).rejects.toBe(reason);
    await flush();
    await vi.advanceTimersByTimeAsync(800);
    expect(attempts).toHaveLength(2);
    controller.abort(reason);
    await pending;
    expect(attempts[0]!.abortFired).toBe(true);
    expect(attempts[1]!.abortFired).toBe(true);
    // No further candidates start after the abort.
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toHaveLength(2);
  });

  it('leaves no timers behind on any settlement path', async () => {
    // Success path.
    let discovery = discoverEndpoint({ candidates: CANDIDATES, connect: makeConnect() });
    await flush();
    attempts[0]!.succeed();
    await discovery;
    expect(vi.getTimerCount()).toBe(0);

    // Failure path.
    discovery = discoverEndpoint({ candidates: [CANDIDATES[0]], connect: makeConnect() });
    const pending = expect(discovery).rejects.toThrow();
    await flush();
    attempts[0]!.fail();
    await pending;
    expect(vi.getTimerCount()).toBe(0);

    // Abort path.
    const controller = new AbortController();
    const reason = new Error('discovery cancelled');
    discovery = discoverEndpoint({
      candidates: CANDIDATES, connect: makeConnect(), signal: controller.signal,
    });
    const pendingAbort = expect(discovery).rejects.toBe(reason);
    await flush();
    controller.abort(reason);
    await pendingAbort;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports progress via onAttempt in order', async () => {
    const events: Array<[string, string]> = [];
    const discovery = discoverEndpoint({
      candidates: CANDIDATES,
      connect: makeConnect(),
      onAttempt: (url, outcome) => events.push([url, outcome]),
    });
    await flush();
    attempts[0]!.fail();
    await flush();
    attempts[1]!.succeed();
    await discovery;
    expect(events).toEqual([
      [CANDIDATES[0], 'probing'],
      [CANDIDATES[0], 'failed'],
      [CANDIDATES[1], 'probing'],
      [CANDIDATES[1], 'ok'],
    ]);
  });
});
