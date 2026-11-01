/** Copy observations and their rendered view in one browser turn, before another batch can advance the grid. */
export async function readLiveSnapshot(evaluate, decodeMessage) {
  const { frames, vm } = await evaluate('JSON.parse(JSON.stringify({ frames: window.__pageFrames ?? [], vm: window.__playaPanel.vms.page }))');
  const facts = frames.flatMap(text => {
    const decoded = decodeMessage(text);
    if (!decoded.ok) throw new Error(`gate decode failed: ${decoded.error.code}`);
    const m = decoded.message;
    return m.kind === 'batch' ? m.events.map(e => e.fact) : m.kind === 'snapshot' ? m.facts.map(e => e.fact) : [];
  });
  return { facts, vm };
}

/** A running clock alone does not establish that the first video frame was presented. */
export function playbackStarted(sample, canvas) {
  return sample.t > 0.5 && (canvas
    ? sample.presentation !== null && sample.stats.framesRendered > 0
    : sample.rvfc.callbacks > 0 && sample.rvfc.presentedFrames > 0);
}

/** Wait for a jointly visible witness without accepting a capture that returned after its deadline. */
export async function waitForLiveSnapshot(name, read, select, {
  timeoutMs = 15000, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), validate = () => {},
} = {}) {
  const started = now();
  let last;
  for (;;) {
    const snapshot = await read();
    if (now() - started >= timeoutMs) throw new Error(`timeout waiting for ${name}: ${JSON.stringify(last)}`);
    validate(snapshot);
    const witness = select(snapshot);
    if (witness) return witness;
    last = { rows: snapshot.vm.rows.map(r => ({ label: r.label, window: r.window })), facts: snapshot.facts.length };
    await pause(100);
  }
}
