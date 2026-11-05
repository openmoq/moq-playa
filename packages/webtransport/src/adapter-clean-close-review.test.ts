import { expect, it, vi } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { connectedPair } from './testkit/pair.js';
import { createControlCodec, SessionState, varint } from '@openmoq/transport';

it.each([16, 18, 22] as const)('clean close on draft %s reaches the peer through transport termination only', async draft => {
  const { client, server, a, b, errors } = await connectedPair(draft);
  const close = vi.fn(); server.onClose = close;
  try {
    const callerHeld = a.closed;
    await client.close(varint(0n)); await flush(128);
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
    expect(close).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    await expect(callerHeld).resolves.toMatchObject({ closeCode: 0 });
    b.close(a.closeInfo); await flush(128);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close.mock.calls[0]?.[0]).toBe(0);
  } finally { await client.close(); await server.close(); }
});

for (const draft of [18, 22] as const) it.each(['clean', 'error', 'healthy'] as const)(`draft ${draft} late SETUP stream creation preserves %s teardown ownership`, async mode => {
  const conn = new MoqtConnection(draft), transport = new TransportSim();
  const codec = createControlCodec(draft);
  transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
  const create = transport.createUnidirectionalStream.bind(transport);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let created!: WritableStream<Uint8Array>;
  transport.createUnidirectionalStream = async () => {
    created = await create(); await held; return created;
  };
  // A delayed backend leaves actual session termination to the test. No local
  // control abort is allowed to overtake it on the clean path.
  const finishClose = transport.close.bind(transport);
  const close = vi.spyOn(transport, 'close').mockImplementation(() => {});
  const outcome = conn.connect(transport).then(() => null, error => error);
  await flush(128);
  expect(created).toBeDefined();
  try {
    if (mode !== 'healthy') await conn.close(mode === 'error' ? varint(1n) : undefined);
    release(); const error = await outcome; await flush(128);
    expect(transport.uniOut[0]!.writeAborted).toBe(mode === 'error');
    if (mode === 'healthy') expect(error).toBeNull();
    else expect(error).toBeInstanceOf(Error);
  } finally {
    release(); close.mockRestore(); finishClose({ closeCode: 0 }); await conn.close();
    transport.closeIncomingSources(); await flush(128);
  }
});

for (const mode of ['standalone', 'standalone-first', 'transport-first'] as const) {
  it(`late control creation keeps the first ${mode} shutdown ownership`, async () => {
    const { Session, EndpointRole } = await import('@openmoq/transport');
    const { createUniPairTopology } = await import('./topology/uni-pair.js');
    const session = new Session(EndpointRole.CLIENT, 18), topology = createUniPairTopology(session);
    const transport = new TransportSim();
    const create = transport.createUnidirectionalStream.bind(transport);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    transport.createUnidirectionalStream = async () => { const stream = await create(); await gate; return stream; };
    const opening = topology.openControlStream(transport).then(() => null, error => error);
    await flush(128);
    if (mode === 'transport-first') {
      topology.shutdown({ transportClosing: true, graceful: true }); topology.shutdown();
    } else {
      topology.shutdown();
      if (mode === 'standalone-first') topology.shutdown({ transportClosing: true, graceful: true });
    }
    release(); expect(await opening).toBeInstanceOf(Error); await flush(128);
    expect(transport.uniOut[0]!.writeAborted).toBe(mode !== 'transport-first');
    transport.closeIncomingSources();
  });
}

for (const draft of [18, 22] as const) it.each(['clean', 'error'] as const)(`draft ${draft} partial incoming SETUP follows %s transport shutdown`, async mode => {
  const conn = new MoqtConnection(draft), transport = new TransportSim();
  const setup = createControlCodec(draft).encode({ type: 'SETUP', setupOptions: new Map() });
  const incoming = transport.openIncomingUni(); incoming.push(setup.subarray(0, 1));
  const opening = conn.connect(transport).then(() => null, error => error);
  await flush(128);
  const close = vi.spyOn(transport, 'close').mockImplementation(() => {});
  try {
    await conn.close(mode === 'error' ? varint(1n) : undefined); await flush(128);
    expect(await opening).toBeInstanceOf(Error);
    expect(incoming.readCancelled).toBe(mode === 'error');
  } finally { close.mockRestore(); transport.close(); transport.closeIncomingSources(); }
});

for (const phase of ['type', 'observer'] as const) it.each(['clean', 'error'] as const)(`draft 16 ${phase} SETUP follows %s transport shutdown`, async mode => {
  const conn = new MoqtConnection(16, { role: 'server' }), transport = new TransportSim();
  const setup = createControlCodec(16).encode({ type: 'CLIENT_SETUP', parameters: new Map() });
  const incoming = transport.pushIncomingBidi();
  const close = vi.spyOn(transport, 'close').mockImplementation(() => {});
  if (phase === 'observer') conn.onQlogEvent = event => {
    if (event.type === 'control_message_parsed') void conn.close(mode === 'error' ? varint(1n) : undefined);
  };
  // A legal two-byte encoding of CLIENT_SETUP (0x20) can be fragmented.
  incoming.push(phase === 'observer' ? setup : new Uint8Array([0x40]));
  const opening = conn.connect(transport).then(() => null, error => error);
  await flush(128);
  try {
    if (phase !== 'observer') await conn.close(mode === 'error' ? varint(1n) : undefined);
    await flush(128);
    expect(await opening).toBeInstanceOf(Error);
    expect(incoming.readCancelled).toBe(mode === 'error');
    if (phase === 'type') expect(incoming.writeAborted).toBe(mode === 'error');
  } finally { close.mockRestore(); transport.close(); transport.closeIncomingSources(); }
});
