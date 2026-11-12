/** Best-effort transport hint: d14/16/18 §7.2, d22 §5.1.2. Never read back. */
export function setSendOrder(writable: WritableStream<Uint8Array> | undefined, rank: number): WritableStream<Uint8Array> | undefined {
  try { if (!writable || !('sendOrder' in writable)) return; } catch { return; }
  try { (writable as WritableStream<Uint8Array> & { sendOrder: number }).sendOrder = rank; } catch { /* advisory */ }
  return writable;
}
