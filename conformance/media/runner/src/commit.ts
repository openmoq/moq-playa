/**
 * Failure-safe commit of a freshly-authored corpus: swap a staged temp tree +
 * index into place, backing up the originals and rolling back in reverse order
 * if ANY step fails. Every filesystem mutation is inside the transaction and has
 * a recorded undo; backups are deleted only after the whole swap succeeds.
 *
 * Filesystem operations are injected ({@link FsOps}) so the transaction — and
 * especially each rollback path — can be fault-injected in tests.
 *
 * @module
 */

export interface FsOps {
  rename(from: string, to: string): void;
  rm(path: string): void;
  exists(path: string): boolean;
}

export interface CommitPaths {
  readonly vectors: string;
  readonly index: string;
  readonly vectorsTmp: string;
  readonly indexTmp: string;
  readonly vectorsBak: string;
  readonly indexBak: string;
  // Optional third artifact swapped ATOMICALLY with the vectors + index (the
  // pinned provenance directory). When present it participates in the same
  // backup-and-swap transaction, so a failure rolls it back too and new vectors
  // are never left paired with stale/partial provenance.
  readonly provenance?: string;
  readonly provenanceTmp?: string;
  readonly provenanceBak?: string;
}

interface Swap { readonly live: string; readonly tmp: string; readonly bak: string }

function swapsOf(p: CommitPaths): Swap[] {
  const swaps: Swap[] = [
    { live: p.vectors, tmp: p.vectorsTmp, bak: p.vectorsBak },
    { live: p.index, tmp: p.indexTmp, bak: p.indexBak },
  ];
  // The provenance artifact is ALL-OR-NONE: either all three paths are present
  // (it joins the transaction) or none are (a pure two-artifact commit). A
  // partial configuration is a programming error — reject it loudly rather than
  // silently dropping provenance from the transaction, which would recreate the
  // stale-provenance hazard this contract exists to prevent.
  const provPresent = [p.provenance, p.provenanceTmp, p.provenanceBak].filter((x) => x !== undefined).length;
  if (provPresent === 3) {
    swaps.push({ live: p.provenance!, tmp: p.provenanceTmp!, bak: p.provenanceBak! });
  } else if (provPresent !== 0) {
    throw new Error(
      `corpus: partial provenance configuration — provenance/provenanceTmp/provenanceBak must ALL be set or ALL omitted (got ${provPresent}/3). ` +
      `Refusing to commit rather than silently drop provenance from the atomic swap.`,
    );
  }
  return swaps;
}

/**
 * Commit the staged corpus. Preconditions: `vectorsTmp` and `indexTmp` exist and
 * are valid. On success the originals are replaced and backups removed; on any
 * failure the originals are restored and the staged temp is discarded, so the
 * canonical corpus is never left missing, partial, or index-mismatched.
 *
 * @throws if a stale backup is present (an interrupted prior run — refuse loudly
 *   rather than clobber it) or if the swap fails (after rolling back).
 */
export function commitCorpus(paths: CommitPaths, fs: FsOps): void {
  const swaps = swapsOf(paths);

  // Refuse if a backup remains from an interrupted prior run — do NOT delete it
  // blindly; it may be the only copy of the original corpus.
  const staleBak = swaps.find((s) => fs.exists(s.bak));
  if (staleBak !== undefined) {
    throw new Error(
      `corpus: refusing to commit — a stale backup is present (${staleBak.bak}). ` +
      `A prior authoring run was interrupted; inspect and restore the original tree manually before re-running.`,
    );
  }

  const undo: Array<() => void> = [];
  try {
    // Phase 1: back up every live artifact. Phase 2: install every staged temp.
    // (Two phases keep the ordering stable and the rollback simple.)
    for (const s of swaps) {
      if (fs.exists(s.live)) { fs.rename(s.live, s.bak); undo.push(() => fs.rename(s.bak, s.live)); }
    }
    for (const s of swaps) {
      fs.rename(s.tmp, s.live); undo.push(() => fs.rename(s.live, s.tmp));
    }
  } catch (err) {
    for (const u of [...undo].reverse()) { try { u(); } catch { /* best-effort restore */ } }
    for (const s of swaps) { try { fs.rm(s.tmp); } catch { /* already moved/gone */ } }
    throw err;
  }

  // Whole swap succeeded — now it is safe to drop the backups.
  for (const s of swaps) fs.rm(s.bak);
}
