/** Local acceptance peer: delay only a video prefix until live delivery overtakes it. */
import { createServer } from 'node:http';
import { startRelayServer } from '../../examples/node-relay/src/server.js';
import type { StartServerOptions } from '../../examples/node-relay/src/server.js';

type Connection = Parameters<NonNullable<StartServerOptions['onEstablished']>>[0];
const events: Array<Record<string, string | number | null>> = [];
const errors: string[] = [];
const waiting = new Set<() => void>();
const connections = new Set<Connection>();
const latestVideo = new Map<string, bigint>();
let sequence = 0;
let receiverAcknowledged = false;
const record = (type: string, values: Record<string, string | number | null> = {}) => {
  if (events.length >= 1024) throw new Error('warm-start evidence capacity exceeded');
  events.push({ seq: ++sequence, type, ...values });
};
const server = await startRelayServer({ host: '127.0.0.1', port: 0, onEstablished: (conn: Connection) => {
  connections.add(conn);
  const onClose = conn.onClose;
  conn.onClose = (code, reason) => { connections.delete(conn); onClose?.(code, reason); };
  const subscriptions = new Map<bigint, string>();
  const streams = new Map<bigint, bigint>();
  const videoAliases = new Map<bigint, bigint>();
  let sentLive = 0;
  const run = (work: () => Promise<void>) => { void work().catch(error => errors.push(String(error))); };
  conn.onSubscribe = (id, ns, track) => {
    const name = new TextDecoder().decode(track); subscriptions.set(id, name);
    run(async () => {
      await server.relay.handleSubscribe(conn, id, ns, track);
    });
  };
  conn.onPublish = publish => run(async () => {
    await server.relay.handlePublish(conn, publish);
    const original = publish.onObject, name = new TextDecoder().decode(publish.trackName);
    publish.onObject = object => {
      original?.(object);
      if (name.startsWith('video') && object.kind === 'data') latestVideo.set(name, object.objectId);
    };
  });
  const accept = conn.acceptSubscribe.bind(conn);
  conn.acceptSubscribe = async (...args) => {
    const [id, alias] = args, name = subscriptions.get(id) ?? '';
    await accept(...args);
    if (!name) return; // Publisher acceptance is not a viewer subscription.
    const value = args[2]?.parameters?.get(0x09n)?.[0];
    const location = value && typeof value === 'object' && 'group' in value && 'object' in value ? value : null;
    record('accepted', { request: String(id), alias: String(alias), name,
      group: location ? String(location.group) : null, object: location ? String(location.object) : null });
    if (name.startsWith('video')) videoAliases.set(alias, id);
  };
  const open = conn.openSubgroup.bind(conn);
  conn.openSubgroup = async (...args) => { const id = await open(...args); streams.set(id, args[0]); return id; };
  const send = conn.sendObject.bind(conn);
  conn.sendObject = async (...args) => {
    await send(...args);
    const alias = streams.get(args[0]);
    if (alias !== undefined && videoAliases.has(alias)) {
      sentLive++; record('live', { alias: String(alias), object: String(args[1]) });
      for (const wake of [...waiting]) wake();
    }
  };
  conn.onFetch = (id, fetch) => {
    const joining = fetch.fetch.fetchType === 2 || fetch.fetch.fetchType === 3
      ? BigInt(fetch.fetch.joiningRequestId) : null;
    record('fetch', { request: String(id), joining: joining === null ? null : String(joining) });
    run(() => server.relay.handleFetch(conn, id, fetch));
  };
  const openFetch = conn.openFetchStream.bind(conn);
  conn.openFetchStream = async (...args) => {
    const request = events.find(event => event.type === 'fetch' && event.request === String(args[0]));
    if (request && typeof request.joining === 'string' && subscriptions.get(BigInt(request.joining))?.startsWith('video')) {
      if (!receiverAcknowledged) await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); waiting.delete(wake); resolve(); };
        const wake = () => { if (receiverAcknowledged) done(); };
        const timer = setTimeout(() => { waiting.delete(wake); reject(new Error('no browser receipt acknowledged the live video')); }, 3000);
        waiting.add(wake);
      });
      record('prefix-released', { request: String(args[0]), liveSent: sentLive, receiverAcknowledged: receiverAcknowledged ? 1 : 0 });
    }
    return openFetch(...args);
  };
  const sendFetch = conn.sendFetchObject.bind(conn);
  conn.sendFetchObject = async (...args) => {
    await sendFetch(...args); record('prefix-object', { group: String(args[1].groupId), object: String(args[1].objectId) });
  };
} });
const control = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/release-prefix') {
    const alias = url.searchParams.get('alias');
    const accepted = events.find(event => event.type === 'accepted' && event.name === 'video-360' && event.alias === alias);
    const witness = ['group', 'object', 'receiptSeq'].map(key => url.searchParams.get(key));
    if (!accepted || witness.some(value => value === null || !/^[0-9]+$/.test(value))) {
      response.writeHead(400).end('Missing accepted video receipt witness'); return;
    }
    receiverAcknowledged = true;
    record('receiver-acknowledged', { alias, group: witness[0]!, object: witness[1]!, receiptSeq: witness[2]! });
    for (const wake of [...waiting]) wake();
  } else if (request.method !== 'GET' || url.pathname !== '/') {
    response.writeHead(404).end(); return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ events, errors, videoPublished: latestVideo.size > 0, receiverAcknowledged }));
});
control.listen(0, '127.0.0.1', () => {
  const address = control.address(); if (!address || typeof address === 'string') throw new Error('Missing control port');
  console.log(`warm-start-ready: ${JSON.stringify({ source: server.url, control: `http://127.0.0.1:${address.port}` })}`);
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true;
  control.close();
  void Promise.all([...connections].map(conn => conn.close())).then(() => server.stop())
    .then(() => process.exit(0), error => { console.error(error); process.exit(1); });
});
