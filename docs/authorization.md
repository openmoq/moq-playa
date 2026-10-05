# CAT4MOQ client authorization

The client accepts issuer-supplied CAT bytes through an asynchronous credential
provider. It does not mint tokens, validate their claims, or decide whether an
operation is allowed. The relay enforces those permissions.

This implements bearer-token carriage for
[CAT4MOQ draft-01](https://www.ietf.org/archive/id/draft-ietf-moq-c4m-01.html)
on the existing MoQ drafts 14, 16 and 18. `catToken(bytes)` uses CAT token type
`0x01` and preserves the opaque issuer bytes. Do not pass a base64 string or an
already encoded MoQ Token structure to this helper.

## Player integration

```ts
import { Player, catToken } from '@openmoq/playa';

const player = new Player(container, {
  url: relayUrl,
  namespace: 'live/stream1',
  authorization: {
    async getTokens(context) {
      // Application-owned issuer integration; return the token's decoded bytes.
      const bytes = await obtainCat(context);
      return [catToken(bytes)];
    },
  },
});
await player.load();
player.play();
```

`obtainCat` belongs to the application. It should honor `context.signal`, avoid
logging credentials, and obtain a grant appropriate to `context.operation`,
`relayUrl`, `namespace` and `trackName`. SETUP has no track target. Namespace
fields are byte arrays: preserve their boundaries rather than joining them into
a string. `existingRequestId` identifies the request referenced by an update or
Joining FETCH.

The provider runs independently for SETUP and each supported authorized request,
including catalog SUBSCRIBE and Joining FETCH, separate initialization tracks,
media subscriptions, publishing and REQUEST_UPDATE. Credentials are not cached
by the library; applications can reuse a bearer CAT when its grant covers the
operation. `SUBSCRIBE_TRACKS` also invokes the generic provider, but CAT4MOQ
draft-01 does not assign that operation an action number. Its authorization
policy must be agreed with the relay rather than inferred from another action.

`@openmoq/player` exposes the same provider option for embeddable players. For
an externally owned connection, configure authorization on the connection, not
the player:

```ts
import { MoqtConnection, catToken } from '@openmoq/webtransport';

const connection = new MoqtConnection(16);
await connection.connect(transport, {
  authorization: {
    relayUrl,
    getTokens: async context => [catToken(await obtainCat(context))],
  },
});
```

The supplied `relayUrl` must identify the actual connected destination. Generic
transport facades do not expose a URL for the adapter to verify independently.

## Broadcast example

The broadcast example is anonymous by default. Enable CAT4MOQ authorization in
its Source panel and paste the issuer's padded base64 token (with or without a
`base64:` prefix). The standard profile uses type 1; select moqx compatibility
explicitly for a deployment requiring type 16. The grant must permit SETUP and
PUBLISH_NAMESPACE for the selected namespace. The same token is supplied to any
other authorized outgoing requests on that connection.

Credentials remain in page memory. Reloading, including applying connection
settings, clears them and disables authorization. They are not saved to browser
storage, query parameters, logs, or viewer links. A viewer needs its own
subscriber grant when the relay requires one. Stop before replacing an expired
token; the example does not contact an issuer or refresh credentials.

## Failure and migration behavior

Provider failure, empty credentials, timeout or connection closure rejects the
operation before sending its request. There is no anonymous retry. Provider
exception text and causes are replaced with a generic `AuthorizationError` to
avoid exposing credentials in logs. Relay authorization errors remain relay
errors; a new token does not automatically retry a rejected request.

The default acquisition deadline is 10 seconds. `timeoutMs` accepts integers
from 1 through 2147483647. Each acquisition accepts at most 16 tokens and 32 KiB
of credential bytes; at most 64 acquisitions can be pending per connection.
Closing the connection aborts their signals and rejects the pending operations
even if the provider ignores cancellation.

Authenticated `REQUEST_UPDATE` calls on the same request are sent in invocation
order, even when credentials finish in a different order. Other requests can
proceed independently. At most 64 authorized updates may be queued per connection;
the queue does not wait for peer acknowledgements before sending the next update.

Player migration to a different relay origin is rejected unless that origin is
listed in `authorization.allowedRelayOrigins`. Same-origin path changes are
allowed. The provider receives the destination URL and acquires new credentials;
allowlisting does not assert that an old CAT is valid at the new relay.

Existing raw `authTokens` options still accept serialized MoQ Token structures.
They are not combined with the provider. Raw SETUP tokens alone do not authorize
later requests: attach request tokens explicitly or use the provider.

Exported `QlogTrace` control-message records redact token bytes to lengths.
Raw `onMessage` and `onQlogEvent` callbacks can contain credentials; do not
serialize those messages directly into logs or telemetry.

## Relay policy and proof-of-possession

Anonymous subscribe and denial of anonymous publishing are relay policies, not
client features. Test both with the deployment's actual authorization settings.
Acquiring a token does not itself prevent unauthorized publishing elsewhere.

CAT4MOQ DPoP signing is not built in. A deployment requiring proof-of-possession
must supply the fresh operation-bound proof alongside the CAT using the generic
token provider and its agreed transport profile. Red5's compatibility token
types `0x10` and `0x11` are not substituted for standard CAT type `0x01`.
Do not reuse a DPoP proof across operations or treat bearer support as a DPoP
conformance claim.

For Red5's retained SETUP grant, a request token does not refresh the session
grant. Establish a new connection with a new SETUP token when required by that
policy. Token expiration and `moqt-reval` enforcement remain relay-owned.

The tests cover wire carriage, signed issuer fixtures, cancellation, migration
trust and player request integration. They do not replace an interop run against
an auth-enabled relay with the deployment's issuer and enforcement configuration.
