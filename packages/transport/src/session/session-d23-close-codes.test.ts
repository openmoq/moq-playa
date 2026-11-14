import { expect, it } from 'vitest';
import { Session } from './session.js';
import type { SessionOutboundAction } from './types.js';
const bytes = new Uint8Array([1]);
function established(draft: 22 | 23, role: 'client' | 'server' = 'client') {
  const session = new Session(role, draft);
  if (role === 'client') session.initiateSetup();
  session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
  if (role === 'server') session.completeSetup();
  return session;
}
const code = (actions: SessionOutboundAction[]) => actions.find(action => action.type === 'close_connection')?.error;
for (const draft of [22, 23] as const) {
  it(`draft${draft} duplicate control GOAWAY`, () => {
    const s = established(draft), message = { type: 'GOAWAY' as const, newSessionUri: '', timeout: 0n };
    s.handleControlMessage(message);
    expect(code(s.handleControlMessage(message))).toBe(draft === 23 ? 0x303n : 3n);
  });
  it(`draft${draft} server rejects GOAWAY URI`, () => {
    const s = established(draft, 'server');
    expect(code(s.handleControlMessage({ type: 'GOAWAY', newSessionUri: 'https://example.test', timeout: 0n })))
      .toBe(draft === 23 ? 0x304n : 3n);
  });
  it(`draft${draft} REQUEST_OK properties outside TRACK_STATUS and FETCH`, () => {
    const s = established(draft), { requestId } = s.subscribeNamespace([bytes]);
    expect(code(s.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map(), trackProperties: new Map([[0x42n, [1n]]]) })))
      .toBe(draft === 23 ? 0x301n : 3n);
  });
  it(`draft${draft} server rejects REDIRECT URI`, () => {
    const s = established(draft, 'server'), { requestId } = s.subscribe([bytes], bytes);
    expect(code(s.handleControlMessage({ type: 'REQUEST_ERROR', requestId, errorCode: 0x34n, retryInterval: 0n, errorReason: '',
      redirect: { connectUri: bytes, trackNamespace: [bytes], trackName: bytes } }))).toBe(draft === 23 ? 0x304n : 3n);
  });
  for (const kind of ['subscribeNamespace', 'publishNamespace', 'subscribeTracks'] as const) {
    it(`draft${draft} ${kind} REDIRECT forbids Track Name`, () => {
      const s = established(draft), { requestId } = s[kind]([bytes]);
      expect(code(s.handleControlMessage({ type: 'REQUEST_ERROR', requestId, errorCode: 0x34n, retryInterval: 0n, errorReason: '',
        redirect: { connectUri: new Uint8Array(), trackNamespace: [bytes], trackName: bytes } }))).toBe(draft === 23 ? 0x301n : 3n);
    });
  }
}
