/**
 * Executable BMFF path against CURRENT production code. The parse helpers live
 * in `@moqt/browser`'s `mp4-box.ts` but are NOT in that package's public barrel,
 * so we deep-import the module directly (test infrastructure, same repo).
 *
 * Critically, every mp4-box function is TOTAL — it returns null/empty on
 * malformed input rather than throwing. So BMFF corpus vectors are all
 * `status: "ok"` with a projection that faithfully records the (possibly null
 * or degraded) return; there are no throw-based error vectors here.
 *
 * @module
 */

// Deep relative import: mp4-box.ts is package-internal (not re-exported from
// @moqt/browser). Pure byte manipulation (DataView/Uint8Array), no DOM.
import {
  peekSegmentMetadata,
  readSegmentTimeRanges,
  readTrexDefaults,
} from '../../../../packages/browser/src/mp4-box.js';

import type { BmffOperation } from './schema-types.js';
import type { ExecResult } from './exec-compare.js';

export type BmffOp = BmffOperation;
export type BmffRunResult = ExecResult;

function bmdStr(v: bigint | null): string | null {
  return v === null ? null : v.toString(10);
}
function intStr(v: number | null): string | null {
  return v === null ? null : String(v);
}

/**
 * Run the current BMFF utility named by `op` and project ONLY its output (the
 * op is chosen from the entry's `operation` field, never inferred from the
 * expected result). All mp4-box helpers are total (null/empty, never throw).
 */
export function runBmff(bytes: Uint8Array, op: BmffOp): BmffRunResult {
  switch (op) {
    case 'trex': {
      const map = readTrexDefaults(bytes);
      const trex = [...map.values()]
        .sort((a, b) => a.trackId - b.trackId)
        .map((t) => ({
          trackId: String(t.trackId),
          defaultSampleDuration: String(t.defaultSampleDuration),
          defaultSampleSize: String(t.defaultSampleSize),
          defaultSampleFlags: String(t.defaultSampleFlags),
        }));
      return { status: 'ok', semantics: { trex } };
    }
    case 'peek': {
      const meta = peekSegmentMetadata(bytes);
      if (meta === null) return { status: 'ok', semantics: { meta: null } };
      return { status: 'ok', semantics: { bmd: bmdStr(meta.bmd), mdatSize: intStr(meta.mdatSize) } };
    }
    case 'timeRanges': {
      const trexMap = readTrexDefaults(bytes);
      const trex = trexMap.get(1);
      const ranges = trex !== undefined ? readSegmentTimeRanges(bytes, trex) : readSegmentTimeRanges(bytes);
      const projected = ranges === null
        ? null
        : ranges.map((r) => ({
          startTime: r.startTime.toString(10),
          endTime: r.endTime.toString(10),
          sampleCount: String(r.sampleCount),
        }));
      return { status: 'ok', semantics: { ranges: projected } };
    }
  }
}
