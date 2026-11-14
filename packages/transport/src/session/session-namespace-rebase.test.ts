import { expect, it } from 'vitest';
import { Session } from './session.js';
const tuple = (...parts: string[]) => parts.map(part => new TextEncoder().encode(part));

for (const draft of [18, 22, 23] as const) for (const role of ['client', 'server'] as const) {
  for (const [label, prefix, expected] of [
    ['narrow', ['a', 'b'], [[], ['c']]],
    ['widen', [], [['a', 'b'], ['a', 'b', 'c'], ['a', 'd']]],
    ['replace', ['z'], []],
  ] as const) it(`draft ${draft} ${role} ${label} rebases discovery only on 23`, () => {
    const session = new Session(role, draft);
    if (role === 'client') session.initiateSetup();
    session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
    if (role === 'server') session.completeSetup();
    const old = [tuple('b'), tuple('b', 'c'), tuple('d')];
    let id: bigint;
    if (role === 'client') {
      id = session.subscribeNamespace(tuple('a')).requestId;
      session.handleControlMessage({ type: 'REQUEST_OK', requestId: id, parameters: new Map() });
      for (const suffix of old) session.handleNamespaceStreamMessage(id, { type: 'NAMESPACE', trackNamespaceSuffix: suffix });
      const update = session.requestUpdate(id, { trackNamespacePrefix: tuple(...prefix) });
      expect(session.getNamespaceSubscription(id)!.discoveredNamespaces).toEqual(old);
      session.handleControlMessage({ type: 'REQUEST_OK', requestId: update.requestId, parameters: new Map() });
    } else {
      id = 0n;
      session.handleControlMessage({ type: 'SUBSCRIBE_NAMESPACE', requestId: id, trackNamespacePrefix: tuple('a'), parameters: new Map() });
      session.acceptSubscribeNamespace(id);
      for (const suffix of old) session.sendNamespace(id, suffix);
      session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: 2n, existingRequestId: id,
        parameters: new Map([[0x34n, [tuple(...prefix)]]]) });
    }
    const state = role === 'client' ? session.getNamespaceSubscription(id)! : session.getIncomingNamespaceSubscription(id)!;
    const retained = draft === 23 ? expected.map(parts => tuple(...parts)) : old;
    expect(state.namespacePrefix).toEqual(tuple(...prefix));
    expect(state.discoveredNamespaces).toEqual(retained);
    for (const suffix of [...retained]) {
      if (role === 'client') {
        expect(session.handleNamespaceStreamMessage(id, { type: 'NAMESPACE_DONE', trackNamespaceSuffix: suffix })
          .some(action => action.type === 'close_connection')).toBe(false);
      } else session.sendNamespaceDone(id, suffix);
    }
    expect(state.discoveredNamespaces).toEqual([]);
    expect(state.isActive).toBe(true);
  });
}
