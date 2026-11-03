import { describe, expect, it } from 'vitest';
import { Session } from './session.js';
import { SessionState } from './types.js';
import { MAX_VARINT, varint } from '../primitives/varint.js';

function client(maximum = 20_001n, draft: 14 | 16 = 16) {
  const session = new Session('client', draft);
  session.initiateSetup({ maxRequestId: varint(maximum) });
  session.handleControlMessage({ type: 'SERVER_SETUP', parameters: new Map([[2n, [100n]]]) });
  return session;
}

describe('draft-16 session request admission', () => {
  it('reports tracking exhaustion as a local resource failure', () => {
    const session = client();
    for (let i = 0n; i < 1024n; i++) {
      const actions = session.handleNamespaceStreamRequest({ type: 'SUBSCRIBE_NAMESPACE',
        requestId: varint(5n + 4n * i), trackNamespacePrefix: [], subscribeOptions: varint(2n), parameters: new Map() });
      expect(actions).not.toContainEqual(expect.objectContaining({ type: 'close_connection' }));
    }
    const actions = session.handleNamespaceStreamRequest({ type: 'SUBSCRIBE_NAMESPACE',
      requestId: varint(4101n), trackNamespacePrefix: [], subscribeOptions: varint(2n), parameters: new Map() });
    expect(actions).toContainEqual(expect.objectContaining({
      type: 'close_connection', error: 1n, reason: expect.stringContaining('tracking capacity'),
    }));
  });

  it('does not generate overflowing credit after a valid high incoming ID', () => {
    const session = client(MAX_VARINT);
    const actions = session.handleControlMessage({ type: 'PUBLISH_NAMESPACE', requestId: varint(MAX_VARINT - 2n),
      trackNamespace: [new TextEncoder().encode('live')], parameters: new Map() });
    expect(session.state).toBe(SessionState.ESTABLISHED);
    expect(actions).not.toContainEqual(expect.objectContaining({ type: 'close_connection' }));
    expect(actions).not.toContainEqual(expect.objectContaining({
      type: 'send_control', message: expect.objectContaining({ type: 'MAX_REQUEST_ID' }),
    }));
  });

  it.each([14, 16] as const)('draft %i clamps the final credit grant and never repeats it', draft => {
    const session = client(MAX_VARINT - 10n, draft);
    const blocked = { type: 'REQUESTS_BLOCKED' as const, maximumRequestId: varint(MAX_VARINT - 10n) };
    const grant = session.handleControlMessage(blocked);
    expect(grant).toEqual([{ type: 'send_control', message: { type: 'MAX_REQUEST_ID', maxRequestId: MAX_VARINT } }]);
    expect(session.handleControlMessage({ ...blocked, maximumRequestId: varint(MAX_VARINT) })).toEqual([]);
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });

  it('clamps automatic credit once while keeping lower reordered requests admissible', () => {
    const session = client(MAX_VARINT - 10n);
    const announce = (id: bigint) => session.handleControlMessage({ type: 'PUBLISH_NAMESPACE', requestId: varint(id),
      trackNamespace: [new TextEncoder().encode(String(id))], parameters: new Map() });
    expect(announce(MAX_VARINT - 12n)).toContainEqual({
      type: 'send_control', message: { type: 'MAX_REQUEST_ID', maxRequestId: MAX_VARINT },
    });
    const next = announce(1n);
    expect(next).not.toContainEqual(expect.objectContaining({ type: 'close_connection' }));
    expect(next).not.toContainEqual(expect.objectContaining({
      type: 'send_control', message: expect.objectContaining({ type: 'MAX_REQUEST_ID' }),
    }));
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });

  it('retains draft-14 ordering checks', () => {
    const session = client(100n, 14);
    expect(session.handleControlMessage({ type: 'PUBLISH_NAMESPACE', requestId: varint(3n),
      trackNamespace: [], parameters: new Map() })).toContainEqual(
      expect.objectContaining({ type: 'close_connection', error: 4n }));
  });
});
