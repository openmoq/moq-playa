export const schedulingWarnings = new WeakMap<object, (stream: WritableStream<Uint8Array>, requestId: bigint | undefined, error: unknown) => void>();
const warned = new WeakSet<WritableStream<Uint8Array>>();
/** Best-effort transport hint: d14/16/18 §7.2, d22 §5.1.2. Never read back. */
export function setSendOrder(writable: WritableStream<Uint8Array> | undefined, rank: number, owner: object, requestId?: bigint): WritableStream<Uint8Array> | undefined {
  const warn = (error: unknown) => {
    if (!writable || warned.has(writable)) return;
    warned.add(writable);
    try { schedulingWarnings.get(owner)?.(writable, requestId, error); } catch { /* observers are advisory */ }
  };
  try { if (!writable || !('sendOrder' in writable)) return; } catch (error) { warn(error); return; }
  try { (writable as WritableStream<Uint8Array> & { sendOrder: number }).sendOrder = rank; } catch (error) { warn(error); }
  return writable;
}
