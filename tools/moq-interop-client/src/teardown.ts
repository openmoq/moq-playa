/**
 * Clean teardown, with exactly ONE close owner.
 *
 * MoqtConnection.close() runs Session.close() -> close_connection -> the
 * underlying transport.close(). The adapter owns that close, so this module
 * must never call transport.close() itself. Testing whether `closed` has
 * settled is NOT a valid test of whether close was already initiated: a normal
 * close that takes more than one event-loop turn would wrongly look un-started
 * and receive a second close().
 *
 * `closed` is captured BEFORE initiating close so a synchronous settle cannot
 * be missed.
 */
export interface ClosablePeer {
  conn: { close(): Promise<unknown> | unknown };
  transport: { closed: Promise<unknown> };
}

export async function teardown(p: ClosablePeer, boundMs: number): Promise<void> {
  const closed = p.transport.closed;
  await p.conn.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise((_r, rej) => {
        timer = setTimeout(() => rej(new Error(`transport close unsettled after ${boundMs}ms`)), boundMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
