/**
 * The REAL external-probe differential lane. Opt-in: run via
 * `pnpm test:corpus:diff` with MOQ_MEDIA_PROBE_BIN set to an absolute path to a
 * built `moq_media_probe`. It is EXCLUDED from the default `pnpm test`
 * (vitest.config.ts ignores `*.diff.test.ts`).
 *
 * It spawns the external probe, performs the capabilities handshake, sends both
 * cohorts (14 LibMoQ imports + 14 successful MSF-01 spec vectors = 28) as one JSONL batch,
 * normalizes each result to corpus semantics, and compares against each vector's
 * pinned oracle keyed by the `libmoq` implementation: 26 conformant vectors match
 * the canonical `expect`; two (the imported mediatimeline + the spec
 * mimetype-canonical vector) match
 * `differential.libmoq.currentBehavior` (the lowercase-mimetype alias). A missing
 * MOQ_MEDIA_PROBE_BIN throws at load — an error, never a skip.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  resolveProbeBin, runProbeBatch, matchResponses, validateCapabilities, selectDiffVectors,
  PROBE_PROTOCOL, type ProbeResponse,
} from './probe-client.js';
import { normalizeProbeResult, type ProbeKind } from './probe-normalize.js';
import { compareImpl } from '../exec-compare.js';

const BIN = resolveProbeBin(); // throws if unset/relative → the lane errors, never skips
const vectors = selectDiffVectors();

describe('external moq-media-probe differential lane (real probe)', () => {
  beforeAll(async () => {
    // Handshake FIRST: validate protocol + required operation/profile support
    // before executing any vector.
    const capReq = { protocol: PROBE_PROTOCOL, id: 'capabilities', operation: 'capabilities' };
    const byId = matchResponses([capReq], await runProbeBatch(BIN, [capReq]));
    const cap = byId.get('capabilities')!;
    expect(cap.status, 'capabilities status').toBe('ok');
    validateCapabilities(cap.result);
  });

  it('selects 28 vectors: 14 LibMoQ imports + 14 successful spec vectors', () => {
    expect(vectors.length).toBe(28);
    expect(vectors.filter((v) => v.cohort === 'libmoq-import').length).toBe(14);
    expect(vectors.filter((v) => v.cohort === 'spec-msf01-success').length).toBe(14);
  });

  it('all 28 match their pinned oracle: 26 canonical expect + 2 libmoq divergences', async () => {
    const responses: ProbeResponse[] = await runProbeBatch(BIN, vectors.map((v) => v.request));
    const byId = matchResponses(vectors.map((v) => v.request), responses);

    let conformant = 0;
    let diverged = 0;
    for (const v of vectors) {
      const resp = byId.get(v.entry.id)!;
      expect(resp.status, `${v.entry.id}: probe status`).toBe('ok');
      const normalized = normalizeProbeResult(resp.result, v.entry.kind as ProbeKind);
      const cmp = compareImpl(v.entry, { status: 'ok', semantics: normalized }, 'libmoq');
      expect(cmp.ok, cmp.detail).toBe(true);
      if (v.entry.differential?.['libmoq']) diverged++; else conformant++;
    }
    // 28 executed = 26 conformant + 2 pinned divergences (NOT 28 exact matches).
    expect(conformant).toBe(26);
    expect(diverged).toBe(2);
  });
});
