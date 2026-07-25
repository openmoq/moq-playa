/**
 * Compare a live execution result against a corpus expectation (or, for a
 * diverging/unimplemented entry, against its recorded `currentBehavior`).
 *
 * @module
 */

import { deepEqualCanonical } from './canonical.js';
import type { ExpectBlock, CorpusEntry, ErrorCategory } from './schema-types.js';

export type ExecResult =
  | { readonly status: 'ok'; readonly semantics: unknown } // decode / semantic
  | { readonly status: 'ok'; readonly bytesHex: string } // encode
  | { readonly status: 'error'; readonly category: string };

/** Whether a live result matches an expect block (status + semantics/bytes/category). */
export function resultMatches(actual: ExecResult, expect: ExpectBlock): boolean {
  if (actual.status !== expect.status) return false;
  if (actual.status === 'error') return actual.category === expect.error?.category;
  if (expect.stage === 'encode') return 'bytesHex' in actual && actual.bytesHex === expect.bytesHex;
  return 'semantics' in actual && deepEqualCanonical(actual.semantics, expect.semantics);
}

export function describeResult(r: ExecResult): string {
  if (r.status === 'error') return `error:${r.category}`;
  return 'bytesHex' in r ? `ok bytes:${r.bytesHex}` : `ok ${JSON.stringify(r.semantics)}`;
}

/** Convert a live result into a canonical ExpectBlock (for recording currentBehavior). */
export function resultToExpect(r: ExecResult, stage: 'decode' | 'encode' | 'semantic'): ExpectBlock {
  if (r.status === 'error') return { status: 'error', stage, error: { category: r.category as ErrorCategory } };
  if ('bytesHex' in r) return { status: 'ok', stage: 'encode', bytesHex: r.bytesHex };
  return { status: 'ok', stage, semantics: r.semantics };
}

export interface Comparison {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Compare a named implementation's live result against the appropriate target:
 * for a diverging (or -unimplemented) entry, the result must match the recorded
 * `differential[impl].currentBehavior` AND must still differ from `expect` (so a
 * future fix that makes it match `expect` fails the run, forcing promotion). Any
 * third result fails. Otherwise the result must match the canonical `expect`.
 */
export function compareImpl(entry: CorpusEntry, actual: ExecResult, impl: string): Comparison {
  const div = entry.differential?.[impl];
  if (div && (div.status === 'diverges' || div.status === 'unimplemented')) {
    const cur = div.currentBehavior;
    if (cur === undefined) return { ok: false, detail: `${entry.id}: ${impl} ${div.status} but no currentBehavior recorded` };
    // A result that now matches `expect` means the divergence is FIXED — fail so
    // the vector gets promoted to "pass" rather than silently staying "diverges".
    if (resultMatches(actual, entry.expect)) {
      return { ok: false, detail: `${entry.id}: live result now MATCHES expect — the divergence is fixed; promote differential.${impl} to "pass"` };
    }
    if (resultMatches(actual, cur)) {
      return { ok: true, detail: `${entry.id}: still diverges as recorded (${impl})` };
    }
    return { ok: false, detail: `${entry.id}: live ${describeResult(actual)} != recorded ${impl} currentBehavior (and != expect)` };
  }
  if (!resultMatches(actual, entry.expect)) {
    return { ok: false, detail: `${entry.id}: live ${describeResult(actual)} != expect` };
  }
  return { ok: true, detail: `${entry.id}: matches expect` };
}

/** Back-compat: the playa runner's comparison (differential key "playa"). */
export function comparePlaya(entry: CorpusEntry, actual: ExecResult): Comparison {
  return compareImpl(entry, actual, 'playa');
}
