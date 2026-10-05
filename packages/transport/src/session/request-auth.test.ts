import { describe, expect, it } from 'vitest';
import { Session } from './session.js';
import { EndpointRole } from './types.js';
import type { RequestResult } from './session.js';
import { createControlCodec } from '../control/codec.js';
import { AliasType, encodeAuthorizationToken, encodeAuthorizationToken18 } from '../control/auth-token.js';
import { MessageParam, SetupParam } from '../control/parameters.js';
import { varint } from '../primitives/varint.js';
import type { ControlMessage } from '../control/messages.js';
import type { DraftVersion } from '../versions.js';

const namespace = [new Uint8Array([0xff, 0x2f]), new Uint8Array([0x61])];
const name = new Uint8Array([0x76]);

function established(version: DraftVersion): Session {
  const session = new Session(EndpointRole.CLIENT, version);
  session.initiateSetup();
  session.handleControlMessage(version === 18
    ? { type: 'SETUP', setupOptions: new Map() }
    : { type: 'SERVER_SETUP', parameters: new Map([[SetupParam.MAX_REQUEST_ID, [varint(1000n)]]]) });
  return session;
}

function message(result: RequestResult): ControlMessage {
  const action = result.actions.find(a => a.type === 'send_control' || a.type === 'open_namespace_stream');
  if (!action || !('message' in action)) throw new Error('No request message');
  return action.message;
}

describe.each([14, 16, 18] as const)('draft %i request authorization', version => {
  const encode = version === 18 ? encodeAuthorizationToken18 : encodeAuthorizationToken;
  const tokens = [1n, 16n].map(tokenType => encode({
    aliasType: AliasType.USE_VALUE, tokenType, tokenValue: new Uint8Array([0xd2, 0x84, 0x41, 0xab]),
  }));
  const auth = { authTokens: tokens };

  it.each(['subscribe', 'fetch', 'joiningFetch', 'publish', 'publishNamespace', 'subscribeNamespace', 'trackStatus'] as const)(
    'preserves repeated tokens on %s through the wire codec', operation => {
      const session = established(version);
      let result: RequestResult;
      switch (operation) {
        case 'subscribe': result = session.subscribe(namespace, name, { ...auth, subscriberPriority: varint(7n) }); break;
        case 'fetch': result = session.fetch(namespace, name, { ...auth, startGroup: 0n, startObject: 0n, endGroup: 1n }); break;
        case 'joiningFetch': {
          const sub = session.subscribe(namespace, name);
          session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId: sub.requestId, trackAlias: varint(9n), parameters: new Map() });
          result = session.joiningFetch({ ...auth, joiningRequestId: sub.requestId, joiningFetchType: 'relative', joiningStart: 0n });
          break;
        }
        case 'publish': result = session.publish(namespace, name, 3n, auth); break;
        case 'publishNamespace': result = session.publishNamespace(namespace, auth); break;
        case 'subscribeNamespace': result = session.subscribeNamespace(namespace, undefined, auth); break;
        case 'trackStatus': result = session.trackStatus(namespace, name, auth); break;
      }
      const codec = createControlCodec(version);
      const decoded = codec.decode(codec.encode(message(result)), 0).message;
      if (!('parameters' in decoded)) throw new Error('No parameters');
      expect(decoded.parameters.get(MessageParam.AUTHORIZATION_TOKEN)).toEqual(tokens);
      if (operation === 'subscribe') expect(decoded.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)).toEqual([7n]);
    },
  );

  it('carries tokens on a subscription update', () => {
    const session = established(version);
    const sub = session.subscribe(namespace, name);
    session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId: sub.requestId, trackAlias: varint(9n), parameters: new Map() });
    const msg = message(session.requestUpdate(sub.requestId, { ...auth, forward: 0 }));
    const codec = createControlCodec(version);
    const decoded = codec.decode(codec.encode(msg), 0).message;
    if (!('parameters' in decoded)) throw new Error('No parameters');
    expect(decoded.parameters.get(MessageParam.AUTHORIZATION_TOKEN)).toEqual(tokens);
  });

  it('owns a copy of Buffer-backed raw request tokens', () => {
    const session = established(version);
    const token = Buffer.from(tokens[0]!);
    const original = Uint8Array.from(token);
    const result = session.subscribe(namespace, name, { authTokens: [token] });
    token.fill(0);
    const msg = message(result);
    if (!('parameters' in msg)) throw new Error('No parameters');
    expect(msg.parameters.get(MessageParam.AUTHORIZATION_TOKEN)).toEqual([original]);
  });

  it.each(['publishNamespace', 'subscribeNamespace', 'subscribeTracks', 'trackStatus'] as const)(
    '%s rejects invalid raw token input before allocating a request ID', operation => {
      const session = established(version);
      const invalid = { authTokens: [null as unknown as Uint8Array] };
      expect(() => {
        if (operation === 'publishNamespace') session.publishNamespace(namespace, invalid);
        else if (operation === 'subscribeNamespace') session.subscribeNamespace(namespace, undefined, invalid);
        else if (operation === 'subscribeTracks') session.subscribeTracks(namespace, invalid);
        else session.trackStatus(namespace, name, invalid);
      }).toThrow();
      expect(session.subscribe(namespace, name).requestId).toBe(0n);
    },
  );
});
