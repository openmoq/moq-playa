// Target-safe native click for the browser gates. A real `Input.dispatchMouseEvent` sequence (user gesture, no DOM
// `.click()`), but the coordinates are never trusted blindly:
//   before dispatch — the element is scrolled into view, the layout must be STABLE (two consecutive animation
//     frames with the same rect) and `elementFromPoint` at the centre must be the element or inside it;
//   at dispatch — a capture-phase DOCUMENT listener (installed once per panel document) sees the click before any
//     handler can rebuild the DOM, resolves the selector the helper announced for this click, and records a scalar
//     `match` (event target is that element or inside it) with the target's id/tag, the mode and the coordinates;
//   after dispatch — exactly one new click must have been recorded and its `match` must be true.
// Any mismatch fails loudly naming what was hit: a click that landed on another control is a harness interaction
// failure, never a silent retry. No DOM node is retained for later comparison.
//
// Optional control: `window.__gateMoveAfterMeasure = selector` hides that element right after the measurement
// returns (before the dispatch can arrive), so a gate can prove a moved target cannot pass as a completed action.
export function createNativeClick({ evaluate, rpc, session: getSession }) {
  // `session` may be a getter: the gates re-attach to the panel document after a reload, and the listener lives in
  // the document, so installation is re-checked on every click (idempotent in-page).
  const install = session => evaluate(session, `(() => { if (window.__gateClicks) return true;
    const rec = window.__gateClicks = []; window.__gateClickExpect = null;
    document.addEventListener('click', e => {
      const expected = window.__gateClickExpect; window.__gateClickExpect = null;
      const intended = expected ? document.querySelector(expected) : null;
      const t = e.target;
      rec.push({ expected, match: !!(intended && t && (intended === t || intended.contains(t))), targetId: t?.id || null, targetTag: t?.tagName || null,
        targetClass: (t && typeof t.className === 'string' && t.className) || null, x: e.clientX, y: e.clientY, mode: window.__playaPanel?.mode ?? null, isTrusted: e.isTrusted });
    }, true);
    return true; })()`);
  return async function click(selector) {
    const session = typeof getSession === 'function' ? getSession() : getSession;
    await install(session);
    const before = await evaluate(session, 'window.__gateClicks.length');
    // Measure in-page: scroll, then wait for a stable rect whose centre hit-tests to the target (≤ 60 frames).
    const m = await evaluate(session, `new Promise(resolve => { const sel = ${JSON.stringify(selector)}; const n = document.querySelector(sel);
      if (!n) return resolve({ missing: true });
      n.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const inside = hit => !!hit && (hit === n || n.contains(hit));
      let frames = 0, last = null; const hits = [];
      const tick = () => { const r = n.getBoundingClientRect(); const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const hit = r.width > 0 && r.height > 0 ? document.elementFromPoint(cx, cy) : null;
        const hitId = hit ? (hit.id || hit.tagName) : null; hits.push(hitId);
        const same = last && last.x === r.x && last.y === r.y && last.width === r.width && last.height === r.height;
        if (same && inside(hit)) {
          window.__gateClickExpect = sel;
          if (window.__gateMoveAfterMeasure === sel) { window.__gateMoveAfterMeasure = null; setTimeout(() => { n.style.display = 'none'; }, 0); }
          return resolve({ rect: r.toJSON(), x: cx, y: cy, hit: hitId, frames, mode: window.__playaPanel?.mode ?? null });
        }
        last = { x: r.x, y: r.y, width: r.width, height: r.height };
        if (++frames > 60) return resolve({ unstable: true, rect: r.toJSON(), hit: hitId, hits: hits.slice(-6), frames });
        requestAnimationFrame(tick); };
      requestAnimationFrame(tick); })`);
    if (m.missing) throw new Error(`click ${selector}: no such element`);
    if (m.unstable) throw new Error(`click ${selector}: layout not stable or centre hit-tests to ${m.hit} after ${m.frames} frames (recent hits ${JSON.stringify(m.hits)}, rect ${JSON.stringify(m.rect)})`);
    const { x, y } = m;
    await rpc(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await rpc(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await rpc(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    const after = await evaluate(session, `(() => { const all = window.__gateClicks; window.__gateClickExpect = null; return { count: all.length, last: all.at(-1) ?? null }; })()`);
    const seen = after.count - before;
    if (seen !== 1) throw new Error(`click ${selector}: expected exactly one new click event, got ${seen} (dispatched at ${x},${y}; last click ${JSON.stringify(after.last)})`);
    const l = after.last;
    const hitName = l.targetId ? `#${l.targetId}` : `${l.targetTag}${l.targetClass ? '.' + l.targetClass.split(' ').join('.') : ''}`;
    if (l.expected !== selector) throw new Error(`click ${selector}: the recorded click was expected for ${JSON.stringify(l.expected)} (hit ${hitName}) — harness bookkeeping failure`);
    if (!l.match) throw new Error(`click ${selector}: landed on ${hitName} (mode ${l.mode}), not the target — harness interaction failure`);
    return { selector, x, y, frames: m.frames, hit: m.hit, received: l };
  };
}
