import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { listen } from 'node:quic';
import { connectQuic } from '../dist/index.js';

const TIMEOUT_MS = 5_000;
const keyPath = process.argv[2];
const certPath = process.argv[3];
if (!keyPath || !certPath) {
  throw new Error('usage: native-smoke.mjs <key.pem> <cert.pem>');
}

function deferred() {
  return Promise.withResolvers();
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function boundPort(endpoint) {
  const polling = (async () => {
    for (;;) {
      const port = endpoint.address?.port;
      if (typeof port === 'number') return port;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  const closed = endpoint.closed.then(
    () => { throw new Error('server endpoint closed before binding'); },
    (error) => { throw error; },
  );
  return bounded(Promise.race([polling, closed]), 'server endpoint bind');
}

function applicationCode(error) {
  assert.equal(error?.type, 'application');
  assert.equal(typeof error.errorCode, 'bigint');
  return error.errorCode;
}

async function readAll(readable) {
  const reader = readable.getReader();
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function firstBatch(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  const { value, done } = await iterator.next();
  assert.equal(done, false, 'peer stream ended before its discriminator byte');
  const length = value.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of value) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, iterator };
}

async function remainingBytes(initial, iterator) {
  const chunks = [initial];
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    chunks.push(...value);
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const clientUniReceived = deferred();
const clientBidiReceived = deferred();
const clientStopResetReceived = deferred();
const clientBackpressureReceived = deferred();
const clientAbortResetReceived = deferred();
const serverAbortStreamReady = deferred();
const serverDatagramReceived = deferred();
const serverSessionReady = deferred();

let endpoint;
let serverSession;
let transport;

try {
  const key = createPrivateKey(readFileSync(keyPath));
  const cert = readFileSync(certPath);
  endpoint = await listen((session) => {
    serverSession = session;
    void session.closed.catch(() => {});
    serverSessionReady.resolve(session);
  }, {
    endpoint: { address: '127.0.0.1:0' },
    sni: { '*': { keys: [key], certs: [cert] } },
    alpn: ['moqt-18'],
    transportParams: { maxDatagramFrameSize: 1200 },
    ondatagram: (data) => serverDatagramReceived.resolve(data.slice()),
    onstream: async (stream) => {
      const { bytes, iterator } = await firstBatch(stream);
      const marker = bytes[0];
      if (marker === 1) {
        clientUniReceived.resolve(await remainingBytes(bytes.subarray(1), iterator));
        return;
      }
      if (marker === 2) {
        stream.onreset = (error) => clientStopResetReceived.resolve(applicationCode(error));
        stream.stopSending(0x2n);
        return;
      }
      if (marker === 5) {
        clientBidiReceived.resolve(await remainingBytes(bytes.subarray(1), iterator));
        const writer = stream.writer;
        await writer.write(new Uint8Array([6, 8]));
        await writer.end();
        return;
      }
      if (marker === 7) {
        // Hold the receive side long enough for the sender's 64 KiB native
        // write budget to exhaust. The bridge must wait for drain and resume,
        // not turn ordinary QUIC flow control into a failed write.
        await new Promise((resolve) => setTimeout(resolve, 200));
        clientBackpressureReceived.resolve(await remainingBytes(bytes.subarray(1), iterator));
        return;
      }
      if (marker === 9) {
        stream.onreset = (error) => clientAbortResetReceived.resolve(applicationCode(error));
        serverAbortStreamReady.resolve();
        return;
      }
      throw new Error(`unexpected client stream marker ${String(marker)}`);
    },
    onerror: (error) => { throw error; },
  });
  void endpoint.closed.catch(() => {});
  const port = await boundPort(endpoint);

  transport = await bounded(connectQuic(
    `moqt://127.0.0.1:${port}/alpha/../beta?x=1#track:local`,
    { allowUnauthorized: true },
  ), 'native QUIC handshake');
  const server = await bounded(serverSessionReady.promise, 'server session');
  assert.equal((await server.opened).protocol, 'moqt-18');
  assert.deepEqual(transport.setupOptions, {
    authority: `127.0.0.1:${port}`,
    path: '/alpha/../beta?x=1',
  });
  const incomingUniReader = transport.incomingUnidirectionalStreams.getReader();

  const datagramWriter = transport.datagrams.writable.getWriter();
  await datagramWriter.write(new Uint8Array([1, 2, 3]));
  assert.deepEqual(
    await bounded(serverDatagramReceived.promise, 'client datagram'),
    new Uint8Array([1, 2, 3]),
  );
  await server.sendDatagram(new Uint8Array([9, 8, 7]));
  assert.deepEqual(
    (await bounded(transport.datagrams.readable.getReader().read(), 'server datagram')).value,
    new Uint8Array([9, 8, 7]),
  );

  const clientUni = await transport.createUnidirectionalStream();
  const clientUniWriter = clientUni.getWriter();
  await clientUniWriter.write(new Uint8Array([1, 4, 5, 6]));
  await clientUniWriter.close();
  assert.deepEqual(
    await bounded(clientUniReceived.promise, 'client unidirectional FIN'),
    new Uint8Array([4, 5, 6]),
  );

  const pressured = await transport.createUnidirectionalStream();
  const pressuredWriter = pressured.getWriter();
  const pressureChunks = 8;
  const pressureChunkSize = 64 * 1024;
  await bounded((async () => {
    await pressuredWriter.write(new Uint8Array([7]));
    for (let i = 0; i < pressureChunks; i++) {
      const chunk = new Uint8Array(pressureChunkSize);
      chunk.fill(i);
      await pressuredWriter.write(chunk);
    }
    await pressuredWriter.close();
  })(), 'flow-controlled writes');
  const pressuredBytes = await bounded(
    clientBackpressureReceived.promise,
    'flow-controlled unidirectional stream',
  );
  assert.equal(pressuredBytes.byteLength, pressureChunks * pressureChunkSize);
  for (let i = 0; i < pressureChunks; i++) {
    assert.equal(pressuredBytes[i * pressureChunkSize], i);
    assert.equal(pressuredBytes[(i + 1) * pressureChunkSize - 1], i);
  }

  const abortable = await transport.createUnidirectionalStream();
  const abortableWriter = abortable.getWriter();
  await abortableWriter.write(new Uint8Array([9]));
  await bounded(serverAbortStreamReady.promise, 'abortable stream arrival');
  const blockedWrites = Array.from({ length: pressureChunks }, () =>
    abortableWriter.write(new Uint8Array(pressureChunkSize)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await bounded(abortableWriter.abort(0x1n), 'flow-controlled abort');
  const blockedResults = await bounded(Promise.allSettled(blockedWrites), 'aborted writes');
  assert.ok(blockedResults.some((result) => result.status === 'rejected'));
  assert.equal(
    await bounded(clientAbortResetReceived.promise, 'RESET_STREAM after flow-controlled abort'),
    0x1n,
  );

  const clientBidi = await transport.createBidirectionalStream();
  const clientBidiWriter = clientBidi.writable.getWriter();
  await clientBidiWriter.write(new Uint8Array([5, 9, 10]));
  await clientBidiWriter.close();
  assert.deepEqual(
    await bounded(clientBidiReceived.promise, 'client bidirectional request'),
    new Uint8Array([9, 10]),
  );
  assert.deepEqual(
    await bounded(readAll(clientBidi.readable), 'server bidirectional response'),
    new Uint8Array([6, 8]),
  );

  const stopped = await transport.createUnidirectionalStream();
  await stopped.getWriter().write(new Uint8Array([2]));
  assert.equal(
    await bounded(clientStopResetReceived.promise, 'RESET_STREAM after STOP_SENDING'),
    0x2n,
  );

  const serverUni = await server.createUnidirectionalStream();
  await serverUni.writer.write(new Uint8Array([3, 7]));
  await serverUni.writer.end();
  const serverUniReadable = (await bounded(incomingUniReader.read(), 'server unidirectional stream')).value;
  assert.deepEqual(
    await bounded(readAll(serverUniReadable), 'server unidirectional FIN'),
    new Uint8Array([3, 7]),
  );

  const serverStopped = deferred();
  const cancellable = await server.createUnidirectionalStream();
  cancellable.onstopsending = (error) => {
    const code = applicationCode(error);
    cancellable.resetStream(code);
    serverStopped.resolve(code);
  };
  await cancellable.writer.write(new Uint8Array([4]));
  const cancellableReadable = (await bounded(
    incomingUniReader.read(),
    'server cancellable stream',
  )).value;
  const cancellableReader = cancellableReadable.getReader();
  assert.deepEqual((await cancellableReader.read()).value, new Uint8Array([4]));
  await cancellableReader.cancel(0x1n);
  assert.equal(await bounded(serverStopped.promise, 'peer STOP_SENDING'), 0x1n);

  const reset = await server.createUnidirectionalStream();
  reset.resetStream(0x12n);
  const resetReadable = (await bounded(
    incomingUniReader.read(),
    'server reset stream',
  )).value;
  await assert.rejects(resetReadable.getReader().read(), (error) => {
    assert.equal(error.streamErrorCode, 0x12);
    return true;
  });

  server.destroy(undefined, { code: 8n, type: 'application', reason: 'smoke done' });
  assert.deepEqual(
    await bounded(transport.closed, 'peer application close'),
    { closeCode: 8, reason: 'smoke done' },
  );
  await bounded(endpoint.close(), 'server endpoint close');
  console.log('native QUIC smoke: pass');
} finally {
  if (transport) {
    try { transport.close({ closeCode: 1, reason: 'smoke cleanup' }); } catch { /* closed */ }
    await bounded(transport.closed.catch(() => {}), 'client cleanup').catch(() => {});
  }
  if (serverSession) {
    try { serverSession.destroy(); } catch { /* closed */ }
  }
  if (endpoint && !endpoint.destroyed) {
    try { endpoint.destroy(); } catch { /* closed */ }
    await bounded(endpoint.closed.catch(() => {}), 'endpoint cleanup').catch(() => {});
  }
}
