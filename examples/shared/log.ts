/** Append a line to the <pre id="log"> element. */
export function log(msg: string): void {
  const el = document.getElementById('log');
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  el.textContent += `[${ts}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

/** Clear the log element. */
export function clearLog(): void {
  const el = document.getElementById('log');
  if (el) el.textContent = '';
}
