// Owner-local Probe: the DevTools document dials a relay ITSELF, with no page
// involved, through `@openmoq/devtools-probe`. The runner owns the transport;
// its capture is admitted into a probe-kind registry, and the ordinary
// diagnostic carrier + HostCore loop runs in-process (no port, no bridge), so
// the panel's adapter consumes exactly the same frames as for a page source.
//
// Everything here starts only on an explicit `start(config)` from the view and
// ends on `stop()`, owner destruction, or the run's own failure. Views never
// own the transport: hide, reload or close of the panel changes nothing.
import { DiagnosticCarrier, DiagnosticRegistry } from '@openmoq/devtools';
import { decodeMessage } from '@openmoq/devtools-protocol';
import { createProbeRunner } from '@openmoq/devtools-probe';
import { HostCore } from './host-core.js';

/**
 * The native WebTransport factory. Constructed promptly and returned so the
 * runner can close a handshake still in progress; `ready` is awaited by the
 * runner, never here. Exactly ONE construction per call, with the offered
 * subprotocols: a browser that ignores the option yields an unobserved
 * protocol (strict refusal or explicit compatibility), and a constructor
 * error reaches the runner's structured dial failure unchanged. No retry.
 */
export function nativeWebTransportFactory({ url, protocols, signal }) {
  if (signal.aborted) return Promise.reject(new Error('Probe cancelled'));
  if (typeof WebTransport !== 'function') return Promise.reject(new Error('WebTransport is not available in this DevTools document'));
  try { return Promise.resolve(new WebTransport(url, { protocols: [...protocols] })); }
  catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
}

/**
 * @param io { ownerId, now(), publish(state), frame(encoded), schedule(fn, ms) → cancel, transportFactory? }
 */
export function createProbeOwner(io) {
  const factory = io.transportFactory ?? nativeWebTransportFactory;
  let runner = null;
  let run = null;            // { run, registry, unregister, connection, carrier, core, config, status, failure, stopPromise, timer }
  let generation = 0;
  let destroyed = false;

  const state = () => run === null ? null : {
    config: run.config, status: run.status, failure: run.failure, scope: run.config.trackHints.length ? 'tracks' : 'setup-only',
    core: run.core ? run.core.state : null,
    // `blocked`: the runner's own stop REJECTED (its close bound expired or the transport had no provable close),
    // so the runner is quarantined and no Start can succeed on this DevTools owner. `canStart` is the one flag the
    // view needs: a settled stopped/failed run permits a retry at once; a blocked one does not.
    blocked: run.blocked, canStart: (run.status === 'stopped' || run.status === 'failed') && run.blocked === null,
  };
  const quarantine = error => { const detail = String(error?.message ?? error).slice(0, 200); return { reason: 'unproven-close', detail,
    message: `the previous run's transport close was never proven (${detail}); close and reopen DevTools to probe again` }; };
  const publish = () => { if (!destroyed) io.publish(state()); };

  /**
   * ONE runner for this DevTools owner. Its quarantine is real evidence: a run whose transport close never
   * settled refuses every successor, and only owner destruction disposes the runner. (A rejected `closed`
   * after a failed handshake is a settled closure and permits retry on this same runner.)
   */
  function ensureRunner() {
    runner ??= createProbeRunner({ ownerId: io.ownerId, clock: { id: 'devtools-performance', now: io.now }, transportFactory: factory });
    return runner;
  }
  /** Release a run's local loop: expiry timer, carrier, registry connection and lease. Idempotent. */
  function release(r) {
    if (r.released) return;
    r.released = true;
    r.cancelTimer?.(); r.cancelTimer = null;
    for (const cancel of r.pendingRelease ?? []) cancel();
    r.pendingRelease = [];
    const close = r.core?.close(); if (close) { try { r.carrier.receive(close); } catch { /* already closed */ } }
    try { r.carrier.close(); } catch { /* idempotent */ }
    try { r.unregister(); } catch { /* idempotent */ }
    try { r.registry.dispose(); } catch { /* idempotent */ }
  }

  /** Drive one carrier exchange: the core's packet goes straight into the local carrier, its reply straight back. */
  function exchange(r, packet) {
    if (run !== r || r.carrier.closed) return;
    const reply = r.carrier.receive(packet);
    deliver(r, reply);
  }
  function deliver(r, reply) {
    if (run !== r || r.released) return;
    if (reply !== null) {
      // Asynchronous, like a real port: the core must never see a reply inside its own send.
      queueMicrotask(() => { if (run === r && !r.released && r.core) r.core.receive(reply, r.generation); });
    }
    armExpiry(r);
  }
  function armExpiry(r) {
    r.cancelTimer?.(); r.cancelTimer = null;
    if (r.released || r.carrier.closed) return;
    const deadline = r.carrier.deadlineMs;
    if (deadline === null) return;
    r.cancelTimer = io.schedule(() => { r.cancelTimer = null; if (run === r) deliver(r, r.carrier.expire()); }, Math.max(0, deadline - io.now()));
  }

  /** Give the local poll one more turn to pull the terminal facts, then release everything. */
  function drainThenRelease(r) {
    r.cancelTimer?.(); r.cancelTimer = null;
    r.pendingRelease = [
      io.schedule(() => { if (run === r) { r.core?.refresh?.(); } }, 0),
      io.schedule(() => { if (run === r) { release(r); publish(); } }, 250),
    ];
  }

  return {
    get state() { return state(); },
    /** The probe lane's adapter saw a gap, or a stalled view recovered: one coalesced whole-source refresh. Never a redial. */
    refresh() {
      const r = run;
      if (!r || r.released || destroyed) return false;
      return r.core?.state.target ? r.core.refresh() : false;
    },
    /** A view (re)connected: give it the probe lane's picture — the hello and a fresh whole-source snapshot. No new run, no new transport. */
    resync() {
      const r = run;
      if (!r || r.released || destroyed) return;
      if (r.lastHello) io.frame(r.lastHello);
      if (r.core?.state.target) r.core.refresh();
    },
    /** Explicit Start. Refuses overlap; the config is validated by the runner. */
    start(config) {
      if (destroyed) throw new Error('Probe owner is destroyed');
      if (run && run.status !== 'stopped' && run.status !== 'failed') throw new Error('A Probe run is already active; stop it first');
      // A quarantined runner is refused HERE, before any generation or factory step, with the recovery stated; the
      // runner's own refusal stays underneath as the backstop. Nothing resets it: only owner destruction disposes it.
      if (run && run.blocked) throw new Error(`Probe quarantined on this DevTools owner: ${run.blocked.message}`);
      // The runner decides whether the previous run is truly over (its quarantine is not bypassed); only then is
      // the previous local loop released and replaced. A generation is consumed only once construction succeeded.
      const r = { config: { ...config, trackHints: [...(config.trackHints ?? [])] }, status: 'starting', failure: null, blocked: null, generation: 0, cancelTimer: null, core: null, released: false };
      const probe = ensureRunner().start(r.config);
      r.generation = ++generation;
      if (run) release(run);
      r.run = probe;
      r.registry = new DiagnosticRegistry({ sourceKind: 'probe' });
      r.unregister = r.registry.register(probe.capture);
      r.connection = r.registry.open(io.ownerId);
      r.carrier = new DiagnosticCarrier(r.connection, { now: io.now });
      r.core = new HostCore({
        send: packet => exchange(r, packet),
        frame: encoded => {
          if (run !== r || r.released || destroyed) return;
          const d = decodeMessage(encoded); if (d.ok && d.message.kind === 'hello') r.lastHello = encoded;
          io.frame(encoded);
        },
        state: s => {
          if (run !== r || r.released || destroyed) return;
          // Our own capture: attach as soon as it is discovered. No user step, no second lease.
          if (s.phase === 'discovered' && s.target === null && s.sources.length === 1 && !r.attached) {
            r.attached = true; r.core.attach(s.sources[0].sourceId, s.sources[0].runId);
          }
          publish();
        },
        schedule: io.schedule,
        exported: () => {},   // probe sources declare no recording capability
      }, { ownerId: io.ownerId, generation: generation - 1 });
      run = r;
      const discover = r.core.bootstrap();
      deliver(r, r.carrier.start(discover));
      probe.ready.then(() => { if (run === r && !r.stopPromise) { r.status = 'ready'; publish(); } },
        // A rejection after Stop was requested is the cancellation itself; stop() owns that outcome. An automatic
        // failure releases the local loop once the runner's own stop has drained the terminal facts.
        error => {
          if (run !== r || r.stopPromise) return;
          r.failure = String(error?.message ?? error).slice(0, 300);
          // The runner rejects `ready` only after its own stop has settled, so this idempotent stop() reports that
          // outcome at once: a rejection is the quarantine, published together with the failure (handshake context
          // kept in `failure`, the teardown fact already on the lane).
          r.stopPromise = probe.stop().then(() => {}, e => { r.blocked = quarantine(e); }).then(() => { if (run !== r) return; r.status = 'failed'; publish(); drainThenRelease(r); });
        });
      publish();
      return state();
    },
    /** Explicit Stop (or owner destruction). Idempotent; resolves when the transport close is proven or failed. */
    async stop(reason = 'stopped by the user') {
      const r = run;
      if (!r) return;
      if (r.stopPromise) {
        // An automatic failure already owns the runner's stop; an explicit Stop finishes the local release now
        // instead of waiting for the brief inspection drain.
        try { await r.stopPromise; } finally { release(r); if (r.status !== 'failed') r.status = 'stopped'; publish(); }
        return;
      }
      {
        if (r.status === 'starting' || r.status === 'ready') r.status = 'stopping';
        publish();
        r.stopPromise = (async () => {
          let failed = null;
          try { await r.run.stop(); } catch (e) { failed = String(e?.message ?? e).slice(0, 300); }
          // Tear the local loop down after the run: the terminal source_state has been drained to the core by now.
          release(r);
          if (failed !== null) { r.status = 'failed'; r.failure = `teardown failed: ${failed}`; r.blocked = quarantine(failed); }
          else if (r.status !== 'failed') { r.status = 'stopped'; r.failure = r.failure ?? reason; }
          publish();
        })();
      }
      await r.stopPromise;
    },
    /** Owner destruction: release this run's local loop unconditionally, even if stop/dispose reject. Idempotent. */
    async destroy() {
      destroyed = true;
      const r = run;
      if (r) release(r);                         // timers, carrier, registry, lease: gone now, whatever stop() does
      try { await this.stop('DevTools closed'); } catch { /* the run's own failure has its facts; nothing to publish after destroy */ }
      if (r) release(r);
      const old = runner; runner = null;
      if (old) await old.dispose().catch(() => {});
    },
  };
}
