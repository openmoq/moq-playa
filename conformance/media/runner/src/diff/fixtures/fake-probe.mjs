/*
 * A controllable fake that speaks moq-media-probe/1 over stdin/stdout, so the
 * Playa differential client can be self-tested WITHOUT the real LibMoQ probe.
 * Misbehavior is selected via the FAKE_MODE env var. This is a test fixture,
 * not part of the shipped runner.
 */
import { createInterface } from 'node:readline';

const mode = process.env['FAKE_MODE'] ?? 'ok';

// Hang forever: never read stdin, never respond, so the client's timeout fires.
if (mode === 'hang') {
  setInterval(() => {}, 1 << 30);
} else {
  const supported = mode !== 'unsupported';
  const capabilities = {
    protocol: 'moq-media-probe/1',
    operations: [
      { operation: 'capabilities', supported: true },
      { operation: 'catalog.parse', supported: true, profiles: [
        { profile: 'msf-00', supported }, { profile: 'msf-01', supported },
        { profile: 'msf-01-draft', supported }, { profile: 'cmsf-01', supported },
      ] },
      { operation: 'catalog.delta.parse', supported: true, profiles: [{ profile: 'msf-01', supported }] },
    ],
  };

  const responses = [];
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const base = { protocol: 'moq-media-probe/1', id: req.id, status: 'ok', diagnostics: [] };
    if (req.operation === 'capabilities') responses.push({ ...base, result: capabilities });
    else responses.push({ ...base, result: { version: '1', tracks: [] } });
  }

  let out = responses;
  if (mode === 'dup' && out.length) out = [...out, out[0]];
  if (mode === 'missing' && out.length) out = out.slice(0, -1);
  if (mode === 'extra') out = [...out, { protocol: 'moq-media-probe/1', id: '__extra__', status: 'ok', diagnostics: [], result: { version: '1', tracks: [] } }];
  if (mode === 'badproto') out = out.map((r) => ({ ...r, protocol: 'wrong/9' }));
  // Malformed response envelopes (must all be rejected by the strict validator).
  if (mode === 'contradictory') out = out.map((r) => ({ protocol: 'moq-media-probe/1', id: r.id, status: 'ok', result: {}, error: { category: 'boom' }, bogus: true }));
  if (mode === 'missing-result') out = out.map((r) => ({ protocol: 'moq-media-probe/1', id: r.id, status: 'ok', diagnostics: [] }));
  if (mode === 'mistyped-diagnostics') out = out.map((r) => ({ ...r, diagnostics: [1, 2] }));
  if (mode === 'unknown-envelope') out = out.map((r) => ({ ...r, surprise: true }));
  if (mode === 'bad-status') out = out.map((r) => ({ protocol: 'moq-media-probe/1', id: r.id, status: 'weird' }));
  if (mode === 'bad-error') out = out.map((r) => ({ protocol: 'moq-media-probe/1', id: r.id, status: 'error', error: { category: 'x' } }));
  if (mode === 'error-extra-keys') out = out.map((r) => ({ protocol: 'moq-media-probe/1', id: r.id, status: 'error', error: { stage: 'operation', category: 'x', message: 'm' }, diagnostics: [] }));

  for (const r of out) process.stdout.write(JSON.stringify(r) + '\n');

  if (mode === 'malformed') process.stdout.write('this is not json\n');
  if (mode === 'overflow') process.stdout.write('x'.repeat(20 * 1024 * 1024) + '\n');
  if (mode === 'stderr') process.stderr.write('an unexpected diagnostic\n');
  // Do NOT call process.exit(0): let stdout drain so large writes are not
  // truncated. The process exits naturally once the event loop empties.
  if (mode === 'exit1') process.exitCode = 1;
}
