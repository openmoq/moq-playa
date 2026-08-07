/**
 * Page-level relay endpoint owner for the browser examples.
 *
 * A non-empty `?url=` is authoritative and skips probing.
 * Otherwise the endpoint is discovered by probing the common deployment
 * conventions on the page host (see relay-url.ts / discover-endpoint.ts).
 *
 * Discovery is a CONVENIENCE FOR THESE EXAMPLES ONLY. A deployed
 * application knows its relay endpoint and should configure the complete
 * URL rather than probe for it.
 *
 * Sharing semantics:
 * - Single-flight: concurrent callers share one discovery.
 * - Success is cached for the page lifetime (and readable synchronously
 *   via `discoveredRelayUrl()` for settings prepopulation).
 * - Failure and cancellation are not cached; relay availability is
 *   external state; the next user action retries.
 * - Cancellation is consumer-counted: a caller's abort detaches only that
 *   caller; when the last live consumer aborts, the underlying probes are
 *   torn down and the slot cleared.
 */

import { explicitRelayUrl, relayCandidates, parseCertHashHex } from './relay-url.js';
import { probeTransport } from './probe-transport.js';
import type { ProbeOptions, ProbeSession } from './probe-transport.js';
import { discoverEndpoint } from './discover-endpoint.js';

export type DiscoveryListener = (
  url: string,
  outcome: 'probing' | 'ok' | 'failed' | 'timeout',
) => void;

export interface RelayEndpointLocation {
  readonly hostname: string;
  readonly search: string;
}

export interface RelayEndpointDeps {
  readonly location: RelayEndpointLocation;
  readonly connect: (
    url: string,
    options: ProbeOptions & { signal: AbortSignal },
  ) => Promise<ProbeSession>;
}

export interface RelayEndpointResolver {
  resolve(options?: { signal?: AbortSignal }): Promise<string>;
  discovered(): string | undefined;
  onAttempt(listener: DiscoveryListener): () => void;
}

interface Slot {
  promise: Promise<string>;
  controller: AbortController;
  consumers: number;
}

/** Build a resolver over explicit deps (the page singleton wires the real ones). */
export function createRelayEndpointResolver(deps: RelayEndpointDeps): RelayEndpointResolver {
  const listeners = new Set<DiscoveryListener>();
  let slot: Slot | undefined;
  let discovered: string | undefined;

  const notify: DiscoveryListener = (url, outcome) => {
    for (const listener of [...listeners]) {
      try {
        listener(url, outcome);
      } catch {
        // A broken listener must not break discovery or its siblings.
      }
    }
  };

  const probeOptionsFromPage = (): ProbeOptions => {
    const params = new URLSearchParams(deps.location.search);
    const hashHex = params.get('hash');
    const v = params.get('v');
    const draftVersion = v === '14' ? 14 : v === '16' ? 16 : v === '18' ? 18 : undefined;
    return {
      ...(hashHex ? { certHash: parseCertHashHex(hashHex) } : {}),
      ...(draftVersion ? { draftVersion } : {}),
    };
  };

  const startDiscovery = (): Slot => {
    const controller = new AbortController();
    const probeOptions = probeOptionsFromPage();
    const promise = discoverEndpoint({
      candidates: relayCandidates(deps.location.hostname),
      connect: (url, signal) => deps.connect(url, { ...probeOptions, signal }),
      signal: controller.signal,
      onAttempt: notify,
    });
    const created: Slot = { promise, controller, consumers: 0 };
    // Only the current slot may be cleared; a stale attempt can settle after
    // its replacement starts. This handler also observes the shared rejection.
    void promise.then(
      (url) => {
        if (slot === created) {
          discovered = url;
          slot = undefined;
        }
      },
      () => {
        if (slot === created) slot = undefined;
      },
    );
    return created;
  };

  const resolve = (options?: { signal?: AbortSignal }): Promise<string> => {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(signal.reason as Error);

    const explicit = explicitRelayUrl(deps.location.search);
    if (explicit) {
      discovered = explicit;
      return Promise.resolve(explicit);
    }
    if (discovered) return Promise.resolve(discovered);

    if (!slot) {
      // Setup errors (malformed ?hash=, empty hostname) become rejections —
      // resolve() must never throw synchronously despite its Promise return.
      try {
        slot = startDiscovery();
      } catch (err) {
        return Promise.reject(err as Error);
      }
    }
    const current = slot;
    current.consumers++;

    if (!signal) {
      return current.promise.finally(() => {
        current.consumers--;
      });
    }

    return new Promise<string>((res, rej) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        current.consumers--;
        if (current.consumers <= 0 && slot === current) {
          // Last live consumer gone: tear down the probes, free the slot.
          current.controller.abort(signal.reason);
          slot = undefined;
        }
        rej(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      current.promise.then(
        (url) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          current.consumers--;
          res(url);
        },
        (err: unknown) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          current.consumers--;
          rej(err as Error);
        },
      );
    });
  };

  return {
    resolve,
    discovered: () => discovered,
    onAttempt: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ─── Page singleton ─────────────────────────────────────────────────

let pageResolver: RelayEndpointResolver | undefined;

function resolver(): RelayEndpointResolver {
  pageResolver ??= createRelayEndpointResolver({
    location: window.location,
    connect: (url, options) => probeTransport(url, options),
  });
  return pageResolver;
}

/**
 * Resolve the relay endpoint for this page (single-flight, shared).
 * Explicit `?url=` short-circuits with zero probes.
 */
export function resolveRelayEndpoint(options?: { signal?: AbortSignal }): Promise<string> {
  return resolver().resolve(options);
}

/** Sync read of the resolved endpoint (for settings prepopulation); never initiates discovery. */
export function discoveredRelayUrl(): string | undefined {
  return pageResolver?.discovered();
}

/** Subscribe to probe progress; returns an unsubscribe function. */
export function onDiscoveryAttempt(listener: DiscoveryListener): () => void {
  return resolver().onAttempt(listener);
}
