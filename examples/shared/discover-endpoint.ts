/**
 * Relay endpoint discovery engine: probe an ordered candidate list with
 * bounded, cancellable handshake attempts and deterministic selection.
 *
 * - Staggered starts: the next candidate launches only when the newest
 *   attempt is still unsettled after `staggerMs` (or immediately when it
 *   fails), so the happy path costs exactly one probe.
 * - Deterministic selection: candidate i wins only once candidates 0..i-1
 *   have all failed or timed out, regardless of settlement order. A held
 *   lower-priority success suppresses further candidate starts.
 * - Every successful probe session is closed the moment it materializes —
 *   winner, held, superseded, or late — only the URL is ever returned.
 * - Real teardown: each attempt owns an AbortController; timeout or
 *   discovery-level abort fires it so the connector closes the connecting
 *   transport instead of abandoning it.
 */

import type { ProbeSession } from './probe-transport.js';

export interface DiscoverOptions {
  /** Candidate endpoint URLs in priority order. */
  readonly candidates: readonly string[];
  /** Connector performing one cancellable handshake attempt (see probeTransport). */
  readonly connect: (url: string, signal: AbortSignal) => Promise<ProbeSession>;
  /** Per-attempt bound; default 2000 ms. */
  readonly attemptTimeoutMs?: number;
  /** Delay before launching the next candidate while the newest is pending; default 800 ms. */
  readonly staggerMs?: number;
  /** Abort the whole discovery (tears down every in-flight attempt). */
  readonly signal?: AbortSignal;
  /** Progress hook for UI ("probing https://…/moq"). */
  readonly onAttempt?: (url: string, outcome: 'probing' | 'ok' | 'failed' | 'timeout') => void;
}

/** Total failure: every candidate failed or timed out. */
export class EndpointDiscoveryError extends Error {
  readonly attempts: readonly { url: string; outcome: 'failed' | 'timeout' }[];

  constructor(attempts: readonly { url: string; outcome: 'failed' | 'timeout' }[]) {
    super(
      `No MoQ relay endpoint found (tried ${attempts.map((a) => a.url).join(', ')}). ` +
      'Start the example relay (pnpm --filter @moqt/example-node-relay server) and retry, ' +
      'or pass an explicit ?url=https://host:port/path (plus ?hash=<sha256-hex> for a self-signed cert).',
    );
    this.name = 'EndpointDiscoveryError';
    this.attempts = attempts;
  }
}

function safeCloseSession(session: ProbeSession): void {
  try {
    session.close();
  } catch {
    // A throwing close ends the probe's usefulness either way.
  }
}

/** Discover the first (by priority) candidate that completes a handshake. */
export function discoverEndpoint(options: DiscoverOptions): Promise<string> {
  const { candidates, connect, signal, onAttempt } = options;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 2000;
  const staggerMs = options.staggerMs ?? 800;

  if (signal?.aborted) return Promise.reject(signal.reason);
  if (candidates.length === 0) return Promise.reject(new EndpointDiscoveryError([]));

  return new Promise<string>((resolve, reject) => {
    type Outcome = 'pending' | 'failed' | 'timeout' | 'ok';
    const outcomes: Outcome[] = candidates.map(() => 'pending');
    const started: boolean[] = candidates.map(() => false);
    const controllers: (AbortController | undefined)[] = candidates.map(() => undefined);
    const timeoutTimers: (ReturnType<typeof setTimeout> | undefined)[] = candidates.map(() => undefined);
    let staggerTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const notify = (i: number, outcome: 'probing' | 'ok' | 'failed' | 'timeout'): void => {
      try {
        onAttempt?.(candidates[i]!, outcome);
      } catch {
        // Progress reporting must never break discovery.
      }
    };

    const clearTimers = (): void => {
      for (let i = 0; i < timeoutTimers.length; i++) {
        const t = timeoutTimers[i];
        if (t !== undefined) clearTimeout(t);
        timeoutTimers[i] = undefined;
      }
      if (staggerTimer !== undefined) {
        clearTimeout(staggerTimer);
        staggerTimer = undefined;
      }
    };

    const onSignalAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      for (const controller of controllers) controller?.abort(signal!.reason);
      reject(signal!.reason as Error);
    };
    signal?.addEventListener('abort', onSignalAbort, { once: true });

    const finish = (outcome: { url: string } | { error: Error }): void => {
      settled = true;
      clearTimers();
      // Tear down every still-pending attempt — a settled discovery must not
      // leave a lower-priority handshake connecting in the background.
      for (let i = 0; i < candidates.length; i++) {
        if (outcomes[i] === 'pending') {
          controllers[i]?.abort(new Error('endpoint discovery settled'));
        }
      }
      signal?.removeEventListener('abort', onSignalAbort);
      if ('url' in outcome) resolve(outcome.url);
      else reject(outcome.error);
    };

    /** Resolve/reject once the priority prefix is decided. */
    const maybeConclude = (): void => {
      if (settled) return;
      for (let i = 0; i < candidates.length; i++) {
        if (outcomes[i] === 'pending') return;                      // higher priority undecided
        if (outcomes[i] === 'ok') return finish({ url: candidates[i]! });
      }
      const attempts = candidates.map((url, i) => ({
        url,
        outcome: outcomes[i] as 'failed' | 'timeout',
      }));
      finish({ error: new EndpointDiscoveryError(attempts) });
    };

    const armStagger = (): void => {
      if (settled || outcomes.includes('ok') || started.every(Boolean)) return;
      staggerTimer = setTimeout(() => {
        staggerTimer = undefined;
        startNext();
      }, staggerMs);
    };

    const startNext = (): void => {
      if (settled || outcomes.includes('ok')) return;               // held success stops starts
      const i = started.findIndex((s) => !s);
      if (i === -1) return;
      startAttempt(i);
      armStagger();
    };

    const onAttemptOver = (): void => {
      if (settled) return;
      if (staggerTimer !== undefined) {
        clearTimeout(staggerTimer);
        staggerTimer = undefined;
      }
      maybeConclude();
      startNext();                                                  // a failure advances immediately
    };

    const startAttempt = (i: number): void => {
      started[i] = true;
      const controller = new AbortController();
      controllers[i] = controller;
      notify(i, 'probing');

      timeoutTimers[i] = setTimeout(() => {
        timeoutTimers[i] = undefined;
        if (settled || outcomes[i] !== 'pending') return;
        outcomes[i] = 'timeout';
        notify(i, 'timeout');
        controller.abort(new Error(`endpoint probe timed out after ${attemptTimeoutMs}ms: ${candidates[i]}`));
        onAttemptOver();
      }, attemptTimeoutMs);

      connect(candidates[i]!, controller.signal).then(
        (session) => {
          // Close every materialized session immediately — winner, held,
          // superseded, or late — only the URL is ever handed onward.
          safeCloseSession(session);
          if (settled || outcomes[i] !== 'pending') return;
          const t = timeoutTimers[i];
          if (t !== undefined) clearTimeout(t);
          timeoutTimers[i] = undefined;
          outcomes[i] = 'ok';
          notify(i, 'ok');
          if (staggerTimer !== undefined) {                          // no starts past a held success
            clearTimeout(staggerTimer);
            staggerTimer = undefined;
          }
          maybeConclude();
        },
        () => {
          if (settled || outcomes[i] !== 'pending') return;
          const t = timeoutTimers[i];
          if (t !== undefined) clearTimeout(t);
          timeoutTimers[i] = undefined;
          outcomes[i] = 'failed';
          notify(i, 'failed');
          onAttemptOver();
        },
      );
    };

    startNext();
  });
}
