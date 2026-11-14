import { expect, it } from 'vitest';
import { Session } from './session.js';
import { SessionState } from './types.js';

for (const draft of [22, 23] as const) for (const fill of [false, true]) {
  it(`draft${draft} inbound SUBSCRIBE_TRACKS fill=${fill}`, () => {
    const session = new Session('client', draft);
    session.initiateSetup();
    session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
    const actions = session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: 1n,
      trackNamespacePrefix: [new Uint8Array([1])],
      parameters: fill ? new Map([[0x23n, [Uint8Array.of(0)]]]) : new Map(),
    });
    const responses = actions.flatMap(a => a.type === 'send_control' ? [a.message] : []);
    if (draft === 23 && fill) {
      expect(responses).toEqual([expect.objectContaining({ type: 'REQUEST_ERROR', requestId: 1n, errorCode: 3n })]);
      expect(() => session.acceptSubscribeTracks(1n)).toThrow(/Unknown incoming/);
    } else {
      expect(responses).toEqual([]);
      expect(session.acceptSubscribeTracks(1n)).toContainEqual(expect.objectContaining({
        type: 'send_control', message: expect.objectContaining({ type: 'REQUEST_OK' }),
      }));
    }
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });
}
