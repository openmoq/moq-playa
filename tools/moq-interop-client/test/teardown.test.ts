/**
 * Focused discriminators for the one-close-owner teardown contract.
 * Each asserts BOTH the verdict and that the underlying close() ran exactly
 * once -- the count is the point: a settled-check-based implementation passes
 * the verdict assertions while still double-closing.
 */
import { teardown as realTeardown, type ClosablePeer } from "../src/teardown.js";
import { teardownOld } from "./teardown.neuter.js";
const NEUTER = process.env.NEUTER === "1";
const teardown = NEUTER ? (teardownOld as typeof realTeardown) : realTeardown;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`ok - ${name}`);
  else { failures++; console.log(`not ok - ${name}${detail ? ` (${detail})` : ""}`); }
}

/** Peer whose adapter close() owns the single underlying transport close. */
function makePeer(settle: "never" | { afterMs: number }) {
  let underlyingCloses = 0;
  let resolveClosed: () => void;
  const closed = new Promise<void>((r) => { resolveClosed = r; });
  const peer: ClosablePeer & { transport: { closed: Promise<unknown>; close(): void }; underlyingCloses: () => number } = {
    conn: {
      async close() {
        // Models MoqtConnection.close(): it calls the underlying close itself.
        underlyingCloses++;
        if (settle !== "never") setTimeout(() => resolveClosed(), settle.afterMs);
      },
    },
    transport: { closed, close() { underlyingCloses++; } },
    underlyingCloses: () => underlyingCloses,
  };
  return peer;
}

async function main() {
  // 1. closed stays pending through the bound -> fails as unsettled, one close.
  {
    const p = makePeer("never");
    let err: Error | null = null;
    try { await teardown(p, 150); } catch (e) { err = e as Error; }
    check("pending-through-bound: teardown fails as unsettled",
      !!err && /unsettled after 150ms/.test(err.message), err ? err.message : "no error thrown");
    check("pending-through-bound: underlying close called exactly once",
      p.underlyingCloses() === 1, `count=${p.underlyingCloses()}`);
  }

  // 2. closed fulfills after MORE than one task turn but inside the bound.
  //    This is the case the old settled-check implementation double-closed.
  {
    const p = makePeer({ afterMs: 60 });
    let err: Error | null = null;
    try { await teardown(p, 1000); } catch (e) { err = e as Error; }
    check("late-but-in-bound: teardown succeeds", err === null, err ? err.message : "");
    check("late-but-in-bound: underlying close called exactly once",
      p.underlyingCloses() === 1, `count=${p.underlyingCloses()}`);
  }

  // 3. The bound timer must not keep the process alive after a success.
  {
    const p = makePeer({ afterMs: 10 });
    const t0 = Date.now();
    await teardown(p, 60_000);
    check("success does not wait for the bound timer", Date.now() - t0 < 5_000);
  }

  console.log(failures === 0 ? "# all teardown discriminators passed" : `# ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
