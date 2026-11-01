// Bounded wait for a Probe OBJECT with its rendered cell. Each poll performs one `read()` (facts + view model, which
// takes real time over CDP) and the deadline is judged on the time that read RETURNED, before the sample is accepted:
// a read that comes back after the deadline is refused even if it carries a matching sample. Same discipline as the
// DevTools-frontend readiness helper; `now`/`pause` are injectable for the helper's own test only.
const defaultPause = ms => new Promise(r => setTimeout(r, ms));
export async function awaitObjectDelivery({ read, deadlineMs, intervalMs = 250, now = () => performance.now(), pause = defaultPause }) {
  const start = now();
  for (;;) {
    const r = await read();
    const elapsedMs = now() - start;
    const matched = !!(r?.sample && r?.cell);
    if (elapsedMs > deadlineMs) return { delivered: false, elapsedMs, lateReturn: matched, ...(r?.diagnostics ?? {}) };
    if (matched) return { delivered: true, elapsedMs, sample: r.sample, cell: r.cell, ...(r.details ?? {}) };
    await pause(intervalMs);
  }
}
