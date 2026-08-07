/**
 * Tests for the page-level relay endpoint owner: explicit ?url= bypass,
 * single-flight sharing with identity-safe slots, success-only caching,
 * consumer-counted cancellation, and listener fanout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRelayEndpointResolver } from './relay-endpoint.js';
import type { ProbeSession, ProbeOptions } from './probe-transport.js';

// ─── Controllable connect fake ──────────────────────────────────────

interface FakeProbe {
  url: string;
  options: ProbeOptions & { signal: AbortSignal };
  abortFired: boolean;
  succeed: () => void;
  fail: (err?: unknown) => void;
}

let probes: FakeProbe[];

function makeConnect(): (url: string, options: ProbeOptions & { signal: AbortSignal }) => Promise<ProbeSession> {
  probes = [];
  return (url, options) => new Promise<ProbeSession>((resolve, reject) => {
    const probe: FakeProbe = {
      url,
      options,
      abortFired: false,
      succeed: () => resolve({ close: () => {} }),
      fail: (err?: unknown) => reject(err ?? new Error(`refused: ${url}`)),
    };
    options.signal.addEventListener('abort', () => {
      probe.abortFired = true;
      reject(options.signal.reason);
    }, { once: true });
    probes.push(probe);
  });
}

function makeResolver(search = '', hostname = 'relay.example.com') {
  const connect = makeConnect();
  return createRelayEndpointResolver({ location: { hostname, search }, connect });
}

const MOQ = 'https://relay.example.com:4433/moq';

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

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('explicit ?url=', () => {
  it('resolves the explicit URL with zero probes', async () => {
    const url = 'https://relay.example.com:9999/custom?x=a%2Fb';
    const resolver = makeResolver(`?url=${encodeURIComponent(url)}`);
    await expect(resolver.resolve()).resolves.toBe(url);
    expect(probes).toHaveLength(0);
    expect(resolver.discovered()).toBe(url);
  });

  it('falls through to discovery for an empty ?url=', async () => {
    const resolver = makeResolver('?url=');
    const resolution = resolver.resolve();
    await flush();
    expect(probes.length).toBeGreaterThan(0);
    probes[0]!.succeed();
    await expect(resolution).resolves.toBe(MOQ);
  });
});

describe('single-flight sharing and caching', () => {
  it('concurrent callers share one discovery and resolve identically', async () => {
    const resolver = makeResolver();
    const a = resolver.resolve();
    const b = resolver.resolve();
    await flush();
    expect(probes).toHaveLength(1);
    probes[0]!.succeed();
    await expect(a).resolves.toBe(MOQ);
    await expect(b).resolves.toBe(MOQ);
    expect(probes).toHaveLength(1);
  });

  it('post-success callers hit the cache; discovered() reads it synchronously', async () => {
    const resolver = makeResolver();
    expect(resolver.discovered()).toBeUndefined();
    const first = resolver.resolve();
    await flush();
    probes[0]!.succeed();
    await first;
    expect(resolver.discovered()).toBe(MOQ);
    await expect(resolver.resolve()).resolves.toBe(MOQ);
    expect(probes).toHaveLength(1);
  });

  it('does NOT cache failure: a later call probes again', async () => {
    const resolver = makeResolver();
    const first = resolver.resolve();
    const firstOutcome = expect(first).rejects.toThrow(/No MoQ relay endpoint found/);
    await flush();
    probes[0]!.fail();
    await flush();
    probes[1]!.fail();
    await flush();
    probes[2]!.fail();
    await firstOutcome;
    expect(resolver.discovered()).toBeUndefined();

    const second = resolver.resolve();
    await flush();
    expect(probes.length).toBe(4);           // re-probing started
    probes[3]!.succeed();
    await expect(second).resolves.toBe(MOQ);
  });
});

describe('consumer-counted cancellation', () => {
  it('rejects immediately for an already-aborted signal without registering or probing', async () => {
    const resolver = makeResolver();
    const controller = new AbortController();
    const reason = new Error('cancelled before start');
    controller.abort(reason);
    await expect(resolver.resolve({ signal: controller.signal })).rejects.toBe(reason);
    await flush();
    expect(probes).toHaveLength(0);
    // The slot was never created/poisoned: a fresh resolve works normally.
    const next = resolver.resolve();
    await flush();
    probes[0]!.succeed();
    await expect(next).resolves.toBe(MOQ);
  });

  it('one aborting consumer detaches while the discovery continues for the other', async () => {
    const resolver = makeResolver();
    const controller = new AbortController();
    const reason = new Error('caller detached');
    const aborting = resolver.resolve({ signal: controller.signal });
    const surviving = resolver.resolve();
    const abortOutcome = expect(aborting).rejects.toBe(reason);
    await flush();
    controller.abort(reason);
    await abortOutcome;
    expect(probes[0]!.abortFired).toBe(false);   // discovery still live
    probes[0]!.succeed();
    await expect(surviving).resolves.toBe(MOQ);
  });

  it('the last aborting consumer tears down the probes and clears the slot for a clean retry', async () => {
    const resolver = makeResolver();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const reason1 = new Error('consumer 1 detached');
    const reason2 = new Error('consumer 2 detached');
    const r1 = resolver.resolve({ signal: c1.signal });
    const r2 = resolver.resolve({ signal: c2.signal });
    const o1 = expect(r1).rejects.toBe(reason1);
    const o2 = expect(r2).rejects.toBe(reason2);
    await flush();
    c1.abort(reason1);
    await o1;
    c2.abort(reason2);
    await o2;
    expect(probes[0]!.abortFired).toBe(true);    // underlying discovery torn down
    // Slot cleared: the next call re-probes.
    const retry = resolver.resolve();
    await flush();
    expect(probes.length).toBe(2);
    probes[1]!.succeed();
    await expect(retry).resolves.toBe(MOQ);
  });

  it('slot identity: an old attempt settling late cannot clear the replacement slot', async () => {
    const resolver = makeResolver();
    const c1 = new AbortController();
    const reason = new Error('sole consumer detached');
    const r1 = resolver.resolve({ signal: c1.signal });
    const o1 = expect(r1).rejects.toBe(reason);
    await flush();
    const attemptA = probes[0]!;
    c1.abort(reason);                             // last consumer → A torn down, slot cleared
    await o1;

    const r2 = resolver.resolve();                // attempt B starts
    await flush();
    expect(probes.length).toBe(2);
    const attemptB = probes[1]!;

    // A's underlying promise settles only NOW (late rejection after replacement).
    attemptA.fail(new Error('late settlement of a dead attempt'));
    await flush();

    // B is unaffected: still live, resolves from its own probe.
    attemptB.succeed();
    await expect(r2).resolves.toBe(MOQ);
    expect(resolver.discovered()).toBe(MOQ);
  });
});

describe('listener fanout', () => {
  it('reports attempts, supports unsubscribe, and contains a throwing listener', async () => {
    const resolver = makeResolver();
    const seen: Array<[string, string]> = [];
    const unsubscribeThrowing = resolver.onAttempt(() => { throw new Error('listener bug'); });
    const unsubscribe = resolver.onAttempt((url, outcome) => seen.push([url, outcome]));

    const resolution = resolver.resolve();
    await flush();
    probes[0]!.succeed();
    await resolution;

    expect(seen).toEqual([[MOQ, 'probing'], [MOQ, 'ok']]);
    unsubscribeThrowing();
    unsubscribe();

    // After unsubscribe, a new discovery reports nothing to the removed listener.
    const resolver2 = makeResolver();
    void resolver2;
    expect(seen).toHaveLength(2);
  });
});

describe('setup-error contract', () => {
  it('rejects (never throws synchronously) on a malformed ?hash=', async () => {
    const resolver = makeResolver('?hash=abc');   // odd hex length
    let returned: Promise<string> | undefined;
    expect(() => { returned = resolver.resolve(); }).not.toThrow();
    await expect(returned!).rejects.toThrow(/odd number of hex chars/);
    expect(probes).toHaveLength(0);
    expect(resolver.discovered()).toBeUndefined();
  });

  it('rejects (never throws synchronously) on an empty hostname', async () => {
    const resolver = makeResolver('', '');
    let returned: Promise<string> | undefined;
    expect(() => { returned = resolver.resolve(); }).not.toThrow();
    await expect(returned!).rejects.toThrow(/hostname/i);
    expect(probes).toHaveLength(0);
  });
});

describe('probe identity', () => {
  it('forwards ?hash= and ?v= to the probe options', async () => {
    const hex = 'abcd';
    const resolver = makeResolver(`?hash=${hex}&v=18`);
    const resolution = resolver.resolve();
    await flush();
    expect(probes[0]!.options.draftVersion).toBe(18);
    expect(Array.from(new Uint8Array(probes[0]!.options.certHash!))).toEqual([0xab, 0xcd]);
    probes[0]!.succeed();
    await resolution;
  });

  it('omits certHash and draftVersion when the page has neither', async () => {
    const resolver = makeResolver();
    const resolution = resolver.resolve();
    await flush();
    expect(probes[0]!.options.certHash).toBeUndefined();
    expect(probes[0]!.options.draftVersion).toBeUndefined();
    probes[0]!.succeed();
    await resolution;
  });
});
