/**
 * Self-tests for the differential client, driven by a controllable FAKE probe
 * (node running fixtures/fake-probe.mjs). Requires NO LibMoQ build, so this runs
 * in the default `pnpm test`.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runProbeBatch, matchResponses, validateCapabilities, resolveProbeBin, ProbeError,
  PROBE_PROTOCOL, type ProbeRequest, type ProbeResponse,
} from './probe-client.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-probe.mjs');
const NODE = process.execPath;

/** Run the fake probe in a given FAKE_MODE. */
function runFake(requests: ProbeRequest[], mode = 'ok', timeoutMs = 5000): Promise<ProbeResponse[]> {
  return runProbeBatch(NODE, requests, { args: [FAKE], env: { FAKE_MODE: mode }, timeoutMs });
}
const req = (id: string, operation = 'capabilities'): ProbeRequest => ({ protocol: PROBE_PROTOCOL, id, operation });

describe('resolveProbeBin — missing bin is an error, never a skip', () => {
  it('throws when MOQ_MEDIA_PROBE_BIN is unset or empty', () => {
    expect(() => resolveProbeBin({})).toThrow(/MOQ_MEDIA_PROBE_BIN is not set/);
    expect(() => resolveProbeBin({ MOQ_MEDIA_PROBE_BIN: '' })).toThrow(/not set/);
  });
  it('rejects a relative path (never searches a sibling checkout)', () => {
    expect(() => resolveProbeBin({ MOQ_MEDIA_PROBE_BIN: './probe' })).toThrow(/ABSOLUTE path/);
  });
  it('accepts an absolute path', () => {
    expect(resolveProbeBin({ MOQ_MEDIA_PROBE_BIN: '/opt/probe' })).toBe('/opt/probe');
  });
});

describe('probe client — happy path and handshake', () => {
  it('one response per request, matched by id', async () => {
    const reqs = [req('a'), req('b')];
    const byId = matchResponses(reqs, await runFake(reqs));
    expect([...byId.keys()].sort()).toEqual(['a', 'b']);
    expect(byId.get('a')!.status).toBe('ok');
  });
  it('capabilities advertises the required operations/profiles', async () => {
    const byId = matchResponses([req('caps')], await runFake([req('caps')]));
    expect(() => validateCapabilities(byId.get('caps')!.result)).not.toThrow();
  });
  it('unsupported capabilities fail (before any vector execution)', async () => {
    const byId = matchResponses([req('caps')], await runFake([req('caps')], 'unsupported'));
    expect(() => validateCapabilities(byId.get('caps')!.result)).toThrow(/not supported/);
  });
});

describe('probe client — every failure mode is rejected loudly', () => {
  it('stderr output', async () => { await expect(runFake([req('a')], 'stderr')).rejects.toThrow(/stderr/); });
  it('nonzero exit', async () => { await expect(runFake([req('a')], 'exit1')).rejects.toThrow(/nonzero code/); });
  it('malformed (non-JSON) line', async () => { await expect(runFake([req('a')], 'malformed')).rejects.toThrow(/non-JSON/); });
  it('stdout overflow', async () => { await expect(runFake([req('a')], 'overflow')).rejects.toThrow(/stdout exceeded/); });
  it('timeout (hung probe)', async () => { await expect(runProbeBatch(NODE, [req('a')], { args: [FAKE], env: { FAKE_MODE: 'hang' }, timeoutMs: 300 })).rejects.toThrow(/timed out/); });

  it('duplicate id', async () => {
    const reqs = [req('a')];
    await expect(runFake(reqs, 'dup').then((r) => matchResponses(reqs, r))).rejects.toThrow(/duplicate response/);
  });
  it('missing id', async () => {
    const reqs = [req('a'), req('b')];
    await expect(runFake(reqs, 'missing').then((r) => matchResponses(reqs, r))).rejects.toThrow(/got 1|missing response/);
  });
  it('extra / unknown-id response', async () => {
    const reqs = [req('a')];
    await expect(runFake(reqs, 'extra').then((r) => matchResponses(reqs, r))).rejects.toThrow(/unknown id/);
  });
  it('protocol mismatch', async () => {
    const reqs = [req('a')];
    await expect(runFake(reqs, 'badproto').then((r) => matchResponses(reqs, r))).rejects.toThrow(/protocol/);
  });
});

describe('probe client — strict response-envelope validation', () => {
  const reqs = [req('a')];
  const badEnvelope = (mode: string, re: RegExp) => async () => {
    await expect(runFake(reqs, mode).then((r) => matchResponses(reqs, r))).rejects.toThrow(re);
  };
  it('contradictory (ok + error + unknown key)', badEnvelope('contradictory', /unexpected key/));
  it('ok missing result', badEnvelope('missing-result', /must carry a "result"/));
  it('ok with mistyped diagnostics', badEnvelope('mistyped-diagnostics', /diagnostics.*array of strings/));
  it('unknown top-level envelope field', badEnvelope('unknown-envelope', /unexpected key "surprise"/));
  it('invalid status value', badEnvelope('bad-status', /invalid status/));
  it('error object missing required string fields', badEnvelope('bad-error', /error\.(stage|message) .* must be a string/));
  it('error envelope carrying forbidden diagnostics', badEnvelope('error-extra-keys', /unexpected key "diagnostics"/));
});

describe('probe client — spawn hygiene', () => {
  it('surfaces a spawn failure for a nonexistent binary', async () => {
    await expect(runProbeBatch('/nonexistent/probe/xyz', [req('a')], { timeoutMs: 2000 })).rejects.toBeInstanceOf(ProbeError);
  });
});
