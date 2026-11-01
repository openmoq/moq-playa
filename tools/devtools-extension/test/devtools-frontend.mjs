// DevTools FRONTEND readiness for the browser gates. The gates open the Playa panel through the frontend's own
// `InspectorView` singleton; asking `InspectorView.instance()` before the frontend has bootstrapped CONSTRUCTS a
// fresh view in a document whose locale data is not registered yet ("No locale data registered for 'en-US'"),
// which is a harness race, not a renderer failure. Readiness is therefore measured, never assumed or slept for:
//   1. `MainImpl.instanceForTest.readyForTest()` — the frontend's bootstrap promise (resolves once the app UI,
//      including the InspectorView, is presented). Missing internals fail loudly: Chrome drift is a gate failure,
//      and a missing-locale exception is never swallowed or retried.
//   2. The registered Playa tab must appear in the InspectorView's tabbed pane (extension panels register after the
//      extension server starts), polled within a bound; absence after the bound is a failure.
// Initialisation is NON-BLOCKING: the first evaluation only schedules the import and the readiness tracking and
// returns at once; the frontend's JS thread (which may be throttled or busy bootstrapping) is never awaited inside
// a CDP call. The driver polls a small state object. Every CDP call made here carries its own explicit bound
// (`callBoundMs`, scoped to opening the panel; the gates' default bounds are untouched elsewhere), and the overall
// readiness deadline is separate and reported distinctly from a single unresponsive call.
// The result reports whether the frontend was still PENDING when its bootstrap promise first became observable
// (raced against a settled marker, no side effects), the import time, the time until ready and the tab polls, so a
// controlled slow-frontend arm can prove the wait was exercised rather than vacuously satisfied on a fast machine.
const defaultPause = ms => new Promise(r => setTimeout(r, ms));

// Deadlines are judged on the time a call RETURNED, never on the time it began: a poll that starts just inside a
// deadline and comes back ready after it is refused, so a slow frontend cannot pass by a late reply.
// `now`/`pause` are injectable for the helper's own test only; the gates use the real clock.
export async function openPlayaPanel({ evaluate, session, readyTimeoutMs = 20000, tabTimeoutMs = 10000, callBoundMs = 15000, now = Date.now, pause = defaultPause }) {
  const t0 = now();
  const bounded = async (label, expression) => {
    try { return await evaluate(session, expression, callBoundMs); }
    catch (e) { if (/CDP timeout/.test(String(e?.message))) throw new Error(`${label}: a single readiness call exceeded its ${callBoundMs} ms bound (frontend thread unresponsive): ${e.message}`); throw e; }
  };
  // Schedule only; nothing is awaited in-page.
  await bounded('frontend init', `(() => { if (window.__gateFrontend) return true;
    const f = window.__gateFrontend = { phase: 'importing', error: null, t0: performance.now(), importMs: null, wasPending: null, readyState: null, readyAt: null };
    (async () => {
      try {
        const main = await import('./entrypoints/main/main.js');
        f.importMs = performance.now() - f.t0;
        const M = main.MainImpl?.MainImpl;
        if (!M || !M.instanceForTest || typeof M.instanceForTest.readyForTest !== 'function') { f.phase = 'error'; f.error = 'DevTools frontend internals drifted: MainImpl.instanceForTest.readyForTest is unavailable'; return; }
        const ready = M.instanceForTest.readyForTest();
        let pending = true;
        await Promise.race([ready.then(() => { pending = false; }), (async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); })()]);
        f.wasPending = pending; f.readyState = document.readyState; f.phase = 'waiting';
        await ready;
        f.readyAt = performance.now(); f.phase = 'ready';
      } catch (e) { f.phase = 'error'; f.error = String(e?.message ?? e).slice(0, 300); }
    })();
    return true; })()`);
  let f;
  for (;;) {
    f = await bounded('frontend readiness poll', `JSON.parse(JSON.stringify(window.__gateFrontend))`);
    if (f.phase === 'error') throw new Error(f.error);
    const elapsed = now() - t0;
    if (elapsed > readyTimeoutMs) throw new Error(`DevTools frontend did not become ready within ${readyTimeoutMs} ms (state ${JSON.stringify(f)} observed at ${elapsed} ms${f.phase === 'ready' ? ', after the deadline' : ''})`);
    if (f.phase === 'ready') break;
    await pause(50);
  }
  const readyAfterMs = now() - t0;
  // The bootstrapped singleton: nothing is constructed here. The Playa tab registers asynchronously.
  let panelId = null, polls = 0;
  const tabStart = now();
  for (;;) {
    const r = await bounded('panel tab lookup', `(async () => { const UI = await import('./ui/legacy/legacy.js'); const view = UI.InspectorView.InspectorView.instance();
      const ids = view.tabbedPane.tabIds(); return { id: ids.find(id => id.startsWith('chrome-extension://') && id.endsWith('Playa')) ?? null, ids }; })()`);
    const elapsed = now() - tabStart;
    if (elapsed > tabTimeoutMs) throw new Error(`Playa panel not registered within ${tabTimeoutMs} ms after the frontend became ready (tabs: ${JSON.stringify(r.ids)} observed at ${elapsed} ms${r.id ? ', after the deadline' : ''})`);
    if (r.id) { panelId = r.id; break; }
    polls++; await pause(50);
  }
  await bounded('show panel', `(async () => { const UI = await import('./ui/legacy/legacy.js'); await UI.InspectorView.InspectorView.instance().showPanel(${JSON.stringify(panelId)}); return true; })()`);
  return { action: 'show registered Playa panel', panelId, wasPending: f.wasPending, arrivalReadyState: f.readyState, importMs: Math.round(f.importMs), readyAfterMs, tabPolls: polls, callBoundMs };
}
