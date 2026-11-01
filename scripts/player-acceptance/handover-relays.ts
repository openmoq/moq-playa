import { createServer } from 'node:http';
import { startRelayServer } from '../../examples/node-relay/src/server.js';
import type { StartServerOptions } from '../../examples/node-relay/src/server.js';
import type { Relay } from '../../examples/node-relay/src/relay.js';

type Connection = Parameters<NonNullable<StartServerOptions['onEstablished']>>[0];
const rejectAudio = process.argv.includes('--reject-audio');
const holdCatalog = process.argv.includes('--hold-catalog');
const events: Array<{ at: number; relay: string; type: string; requestId?: string; name?: string }> = [];
const connections = new Set<Connection>();
const viewers = new Map<Connection, bigint>();
const held: Array<() => Promise<void>> = [];
const relays = new Map<string, Relay>();
const objects = { source: 0, target: 0 };
let dispatches = Promise.resolve();
let released = false;
let redirected = false;
const errors: string[] = [];

function dispatch(run: () => Promise<void>) {
  dispatches = dispatches.then(run).catch(error => { errors.push(String(error)); });
}

const established = (relay: 'source' | 'target') => (conn: Connection) => {
  connections.add(conn);
  const subscriptions = new Set<bigint>();
  const record = (type: string, requestId?: bigint, name?: string) => events.push({
    at: performance.now(), relay, type,
    ...(requestId !== undefined ? { requestId: requestId.toString() } : {}),
    ...(name !== undefined ? { name } : {}),
  });
  conn.onSubscribe = (requestId, namespace, track) => {
    subscriptions.add(requestId);
    const name = new TextDecoder().decode(track);
    if (relay === 'source' && requestId + 2n > (viewers.get(conn) ?? 0n)) viewers.set(conn, requestId + 2n);
    record('subscribe', requestId, name);
    const serve = async () => {
      // Catalog retrieval may retry while this relay deliberately holds its
      // response. Never accept a request the subscriber already cancelled.
      if (!connections.has(conn) || !subscriptions.has(requestId)) return;
      if (relay === 'target' && rejectAudio && name.startsWith('audio')) {
        record('refused', requestId, name);
        await conn.rejectSubscribe(requestId, 0x10n, 'handover audio unavailable');
      } else {
        record('released', requestId, name);
        await relays.get(relay)!.handleSubscribe(conn, requestId, namespace, track);
      }
    };
    if (relay === 'target' && !released && (holdCatalog || name !== 'catalog')) held.push(serve);
    else dispatch(serve);
  };
  conn.onFetch = (requestId, fetch) => {
    record('fetch', requestId);
    const serve = async () => {
      if (!connections.has(conn)) return;
      if ((fetch.fetch.fetchType === 2 || fetch.fetch.fetchType === 3)
          && !subscriptions.has(BigInt(fetch.fetch.joiningRequestId))) return;
      await relays.get(relay)!.handleFetch(conn, requestId, fetch);
    };
    if (relay === 'target' && holdCatalog && !released) held.push(serve);
    else dispatch(serve);
  };
  const sendObject = conn.sendObject.bind(conn);
  conn.sendObject = async (...args) => {
    await sendObject(...args);
    objects[relay]++;
  };
  const unsubscribe = conn.onSubscribeClosed;
  conn.onSubscribeClosed = requestId => {
    subscriptions.delete(requestId);
    record('unsubscribe', requestId);
    unsubscribe?.(requestId);
  };
  const close = conn.onClose;
  conn.onClose = (code, reason) => {
    record('close');
    connections.delete(conn);
    subscriptions.clear();
    viewers.delete(conn);
    close?.(code, reason);
  };
};

const source = await startRelayServer({ host: '127.0.0.1', port: 0, onEstablished: established('source') });
relays.set('source', source.relay);
const target = await startRelayServer({ host: '127.0.0.1', port: 0, onEstablished: established('target') })
  .catch(async error => { await source.stop(); throw error; });
relays.set('target', target.relay);
const control = createServer((request, response) => {
  void (async () => {
    if (request.method === 'POST' && request.url === '/goaway') {
      if (redirected || viewers.size !== 1) throw new Error(`Expected one unredirected viewer, got ${viewers.size}`);
      redirected = true;
      for (const [conn, nextRequestId] of viewers) {
        events.push({ at: performance.now(), relay: 'source', type: 'goaway' });
        await conn.sendGoaway({ newSessionUri: target.url, requestId: nextRequestId, timeout: 0n });
      }
    } else if (request.method === 'POST' && request.url === '/release') {
      released = true;
      for (const serve of held.splice(0)) dispatch(serve);
      await dispatches;
    } else if (request.method !== 'GET' || request.url !== '/status') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ events, held: held.length, released, objects, errors }));
  })().catch(error => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error) }));
  });
});
control.listen(0, '127.0.0.1', () => {
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Missing control port');
  console.log(`handover-ready: ${JSON.stringify({ source: source.url, target: target.url, control: `http://127.0.0.1:${address.port}` })}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  control.close();
  held.length = 0;
  await Promise.all([...connections].map(conn => conn.close()));
  await Promise.all([source.stop(), target.stop()]);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
});
