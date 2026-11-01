// The readiness helper's deadline rule, proven without a browser: a fake `evaluate` and a controlled clock. A reply
// that arrives READY (or with the Playa tab registered) only after its deadline must be refused, a reply within it
// accepted, a single call exceeding its bound reported distinctly, and internals drift reported as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPlayaPanel } from './devtools-frontend.mjs';

// Scripted frontend: each poll advances the clock by `callMs` and returns the scripted state.
function fake({ states, tabs = [{ id: 'chrome-extension://xPlaya', ids: ['elements', 'chrome-extension://xPlaya'] }], callMs = 100 }) {
  let t = 0, polls = 0, tabPolls = 0, shown = null;
  const evaluate = async (_s, expression, timeoutMs) => {
    if (/__gateFrontend = /.test(expression)) { t += callMs; return true; }
    if (/JSON\.parse\(JSON\.stringify\(window\.__gateFrontend\)\)/.test(expression)) { const st = states[Math.min(polls, states.length - 1)]; polls++; t += typeof st.callMs === 'number' ? st.callMs : callMs;
      if (st.timeout) throw new Error(`CDP timeout Runtime.evaluate (${timeoutMs} ms)`); return { phase: st.phase, error: st.error ?? null, importMs: 10, wasPending: true, readyState: 'complete' }; }
    if (/tabIds\(\)/.test(expression)) { const tb = tabs[Math.min(tabPolls, tabs.length - 1)]; tabPolls++; t += typeof tb.callMs === 'number' ? tb.callMs : callMs; return { id: tb.id, ids: tb.ids }; }
    if (/showPanel\(/.test(expression)) { shown = expression.match(/showPanel\("([^"]+)"\)/)[1]; t += callMs; return true; }
    throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
  };
  return { evaluate, now: () => t, pause: async ms => { t += ms; }, get shown() { return shown; }, get polls() { return polls; } };
}
const opts = f => ({ evaluate: f.evaluate, session: 's', now: f.now, pause: f.pause, readyTimeoutMs: 2000, tabTimeoutMs: 1000, callBoundMs: 1500 });

test('ready within the deadline is accepted and the panel is shown', async () => {
  const f = fake({ states: [{ phase: 'importing' }, { phase: 'waiting' }, { phase: 'ready' }] });
  const r = await openPlayaPanel(opts(f));
  assert.equal(r.panelId, 'chrome-extension://xPlaya'); assert.equal(f.shown, 'chrome-extension://xPlaya'); assert.equal(r.wasPending, true);
  assert.ok(r.readyAfterMs <= 2000, `readyAfterMs ${r.readyAfterMs}`);
});
test('ready observed AFTER the readiness deadline is refused, even though the reply says ready', async () => {
  // the last poll begins at ~1900 ms (inside the deadline) and takes 300 ms: it returns ready at ~2200 ms
  const f = fake({ states: [{ phase: 'waiting', callMs: 900 }, { phase: 'waiting', callMs: 900 }, { phase: 'ready', callMs: 300 }] });
  await assert.rejects(openPlayaPanel(opts(f)), /did not become ready within 2000 ms .*after the deadline/);
  assert.equal(f.shown, null, 'nothing may be shown after a refused readiness');
});
test('a Playa tab registered AFTER the tab deadline is refused', async () => {
  const f = fake({ states: [{ phase: 'ready' }], tabs: [{ id: null, ids: ['elements'], callMs: 600 }, { id: 'chrome-extension://xPlaya', ids: ['elements', 'chrome-extension://xPlaya'], callMs: 600 }] });
  await assert.rejects(openPlayaPanel(opts(f)), /not registered within 1000 ms .*after the deadline/);
  assert.equal(f.shown, null);
});
test('a single poll exceeding its own bound is reported distinctly, not as the readiness deadline', async () => {
  const f = fake({ states: [{ phase: 'waiting', timeout: true }] });
  await assert.rejects(openPlayaPanel(opts(f)), /single readiness call exceeded its 1500 ms bound/);
});
test('frontend internals drift is reported as such', async () => {
  const f = fake({ states: [{ phase: 'error', error: 'DevTools frontend internals drifted: MainImpl.instanceForTest.readyForTest is unavailable' }] });
  await assert.rejects(openPlayaPanel(opts(f)), /internals drifted/);
});
