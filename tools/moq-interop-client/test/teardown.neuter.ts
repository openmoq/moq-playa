// TEMPORARY neuter check: the previous settled-check teardown, to prove the
// discriminators actually detect a double close rather than passing vacuously.
import type { ClosablePeer } from "../src/teardown.js";
export async function teardownOld(p: ClosablePeer & { transport: any }, boundMs: number): Promise<void> {
  let settled = false;
  const mark = () => { settled = true; };
  p.transport.closed.then(mark, mark);
  await p.conn.close();
  await new Promise((r) => setTimeout(r, 0));
  if (!settled) p.transport.close();
  await Promise.race([
    p.transport.closed,
    new Promise((_r, rej) => setTimeout(() => rej(new Error(`transport close unsettled after ${boundMs}ms`)), boundMs)),
  ]);
}
