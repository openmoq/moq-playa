import { describe, expect, it } from 'vitest';
import { DiagnosticCapture } from './capture.js';
import { DiagnosticRegistry } from './registry.js';
import { installDiagnosticBridge } from './page-bridge.js';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION } from '@openmoq/devtools-protocol';
import { fixtureSource } from '@openmoq/devtools-protocol/fixtures';

function capture(kind: 'attached' | 'probe') {
  return new DiagnosticCapture({ source: { ...fixtureSource, kind }, clock: { id: 'local', now: () => 0 } });
}

describe('owner-local Probe admission', () => {
  it('keeps page registries attached-only by default', () => {
    const registry = new DiagnosticRegistry();
    expect(() => registry.register(capture('probe'))).toThrow();
    expect(() => registry.register(capture('attached'))).not.toThrow();
  });

  it('admits only probe sources in an explicitly local Probe registry', () => {
    const registry = new DiagnosticRegistry({ sourceKind: 'probe' });
    registry.register(capture('probe'));
    expect(() => registry.register(capture('attached'))).toThrow();
    const owner = registry.open('devtools-owner');
    const replies = owner.request(encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION,
      kind: 'attach', requestId: 'attach', target: { ownerId: 'devtools-owner', sourceId: fixtureSource.sourceId, runId: fixtureSource.runId } }));
    expect(decodeMessage(replies[0])).toMatchObject({ ok: true, message: { kind: 'snapshot', source: { kind: 'probe' } } });
  });

  it('refuses exposing a local Probe registry through a page bridge before installing anything', () => {
    const registry = new DiagnosticRegistry({ sourceKind: 'probe' });
    expect(() => installDiagnosticBridge(registry)).toThrow(/Probe registry/);
  });
});
