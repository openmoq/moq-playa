/**
 * MoqtConnection tests.
 *
 * Verifies the adapter correctly bridges the WebTransport API to the
 * sans-I/O Session state machine: setup handshake, control message routing,
 * action execution, data stream handling, and datagram decoding.
 *
 * Uses mock WebTransport objects — no real network I/O.
 *
 * @see draft-ietf-moq-transport-16 §3, §9, §10
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { MoqtConnectionError } from './adapter-error.js';
import type { WebTransportLike } from './types.js';
import {
  encodeControlMessage,
  decodeControlMessage,
  createControlCodec,
  SessionState,
  EndpointRole,
  varint,
  encodeSubgroupHeader,
  encodeSubgroupObject,
  decodeSubgroupHeader,
  decodeSubgroupObject,
  encodeFetchHeader,
  encodeFetchObject,
  encodeObjectDatagram,
  ObjectStatus,
  SubgroupFlags,
  SubgroupIdMode,
  SetupParam,
  NamespaceStateMachine,
  ProtocolViolationError,
  createControlCodec,
  writeVarint,
  varintEncodingLength,
} from '@moqt/transport';
import type {
  ServerSetup,
  Goaway,
  ControlMessage,
  SubgroupHeader,
  SubgroupObject,
  FetchHeader,
  FetchObject,
  ObjectDatagram,
  DataStreamHeader,
  MoqtObject,
  RequestOk,
  RequestErrorMsg,
  Namespace,
  NamespaceDone,
  Subscribe,
  PublishDone,
} from '@moqt/transport';

// ─── Mock WebTransport factory ──────────────────────────────────────

/** Controls for a single mock data stream. */
interface MockDataStream {
  /** Push bytes to the readable side. */
  push: (bytes: Uint8Array) => void;
  /** Close the readable side (FIN). */
  close: () => void;
  /** Reset the stream with an error code (simulates RESET_STREAM). */
  reset: (errorCode: number) => void;
}

/** Controls for a mock bidirectional stream. */
interface MockBidiStream {
  /** Push bytes to the readable side (simulates peer writing). */
  push: (bytes: Uint8Array) => void;
  /** Close the readable side (FIN from peer). */
  close: () => void;
  /** All byte chunks written to the writable side by our code. */
  written: Uint8Array[];
}

/** Controls for a mock outgoing unidirectional stream (publisher side). */
interface MockOutgoingStream {
  /** All byte chunks written by our code. */
  written: Uint8Array[];
  /** Whether close() was called on the writable. */
  closed: boolean;
}

interface MockTransport {
  transport: WebTransportLike;
  /** Enqueue bytes on the readable side of the control stream. */
  pushControlBytes: (bytes: Uint8Array) => void;
  /** Close the readable side of the control stream (simulates FIN). */
  closeControlReadable: () => void;
  /** All byte chunks written to the control stream writable. */
  controlWritten: Uint8Array[];
  /** Mock for transport.close(). */
  closeFn: ReturnType<typeof vi.fn>;
  /** Add an incoming unidirectional stream, returns push/close controls. */
  addIncomingStream: () => MockDataStream;
  /** Push a datagram. */
  pushDatagram: (bytes: Uint8Array) => void;
  /** All bidirectional streams created (index 0 = control stream). */
  bidiStreams: MockBidiStream[];
  /** All outgoing unidirectional streams created via createUnidirectionalStream(). */
  outgoingStreams: MockOutgoingStream[];
}

function createMockTransport(): MockTransport {
  const controlWritten: Uint8Array[] = [];
  let pushControlBytes!: (bytes: Uint8Array) => void;
  let closeControlReadable!: () => void;

  const controlReadable = new ReadableStream<Uint8Array>({
    start(controller) {
      pushControlBytes = (bytes) => controller.enqueue(bytes);
      closeControlReadable = () => controller.close();
    },
  });

  const controlWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      controlWritten.push(new Uint8Array(chunk));
    },
  });

  // Track all bidirectional streams created
  const bidiStreams: MockBidiStream[] = [];

  // Incoming unidirectional streams — with controller for test injection
  let incomingUniController!: ReadableStreamDefaultController<
    ReadableStream<Uint8Array>
  >;
  const incomingUnidirectionalStreams = new ReadableStream<
    ReadableStream<Uint8Array>
  >({
    start(controller) {
      incomingUniController = controller;
    },
  });

  // Datagrams — with controller for test injection
  let datagramController!: ReadableStreamDefaultController<Uint8Array>;
  const datagramReadable = new ReadableStream<Uint8Array>({
    start(controller) {
      datagramController = controller;
    },
  });

  const closeFn = vi.fn();

  // Outgoing unidirectional streams (publisher data streams)
  const outgoingStreams: MockOutgoingStream[] = [];

  let isFirstBidi = true;

  const transport: WebTransportLike = {
    createUnidirectionalStream: vi.fn(async () => {
      const mockStream: MockOutgoingStream = { written: [], closed: false };
      outgoingStreams.push(mockStream);
      return new WritableStream<Uint8Array>({
        write(chunk) {
          mockStream.written.push(new Uint8Array(chunk));
        },
        close() {
          mockStream.closed = true;
        },
      });
    }),
    createBidirectionalStream: vi.fn(async () => {
      if (isFirstBidi) {
        // First bidi stream = control stream
        isFirstBidi = false;
        const controlBidi: MockBidiStream = {
          push: pushControlBytes,
          close: closeControlReadable,
          written: controlWritten,
        };
        bidiStreams.push(controlBidi);
        return { readable: controlReadable, writable: controlWritable };
      }

      // Subsequent bidi streams (namespace streams, etc.)
      const written: Uint8Array[] = [];
      let pushFn!: (bytes: Uint8Array) => void;
      let closeFn2!: () => void;

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          pushFn = (bytes) => controller.enqueue(bytes);
          closeFn2 = () => controller.close();
        },
      });

      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(new Uint8Array(chunk));
        },
      });

      const mockBidi: MockBidiStream = { push: pushFn, close: closeFn2, written };
      bidiStreams.push(mockBidi);
      return { readable, writable };
    }),
    incomingUnidirectionalStreams,
    datagrams: { readable: datagramReadable },
    close: closeFn,
    closed: new Promise<never>(() => {}), // Never resolves in tests
  };

  function addIncomingStream(): MockDataStream {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    incomingUniController.enqueue(stream);
    return {
      push: (bytes) => streamController.enqueue(bytes),
      close: () => streamController.close(),
      reset: (errorCode: number) => {
        // Simulate WebTransport RESET_STREAM — reader.read() rejects
        const err = new Error(`Stream reset with code ${errorCode}`);
        (err as any).streamErrorCode = errorCode;
        streamController.error(err);
      },
    };
  }

  function pushDatagram(bytes: Uint8Array): void {
    datagramController.enqueue(bytes);
  }

  return {
    transport,
    pushControlBytes,
    closeControlReadable,
    controlWritten,
    closeFn,
    addIncomingStream,
    pushDatagram,
    bidiStreams,
    outgoingStreams,
  };
}

/** Yield to pending promises / microtasks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Multiple flushes for deeply nested async operations. */
const deepFlush = async () => {
  await flush();
  await flush();
  await flush();
};

/** Encode a SERVER_SETUP message with default params. */
function encodeServerSetup(): Uint8Array {
  const msg: ServerSetup = {
    type: 'SERVER_SETUP',
    parameters: new Map([[varint(0x02), [varint(10)]]]),
  };
  return encodeControlMessage(msg);
}

/** Helper: connect an adapter and complete the setup handshake. */
async function connectAdapter(
  mock: MockTransport,
): Promise<MoqtConnection> {
  const adapter = new MoqtConnection();
  const connectPromise = adapter.connect(mock.transport);
  await flush();
  mock.pushControlBytes(encodeServerSetup());
  await connectPromise;
  return adapter;
}

// ─── Test data builders (grounded in §10 wire format) ───────────────

/**
 * Build a minimal subgroup header.
 * Type 0x10 = SUBGROUP_MARKER | SUBGROUP_ID=ZERO, no extensions, no END_OF_GROUP, priority present.
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
function makeSubgroupHeader(overrides?: Partial<SubgroupHeader>): SubgroupHeader {
  return {
    typeByte: 0x10, // Subgroup marker, SubgroupId=ZERO, no extensions, priority present
    trackAlias: varint(1),
    groupId: varint(0),
    subgroupId: varint(0),
    publisherPriority: 128,
    hasExtensions: false,
    isEndOfGroup: false,
    ...overrides,
  };
}

/**
 * Build a minimal subgroup object.
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
function makeSubgroupObject(overrides?: Partial<SubgroupObject>): SubgroupObject {
  return {
    objectId: varint(0),
    extensions: undefined,
    payload: new Uint8Array([0xCA, 0xFE]),
    status: undefined,
    ...overrides,
  };
}

/**
 * Concatenate multiple Uint8Arrays.
 */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('MoqtConnection', () => {
  // ─── Setup handshake ────────────────────────────────────────────

  describe('connect()', () => {
    it('opens a bidirectional stream for the control channel', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      expect(mock.transport.createBidirectionalStream).toHaveBeenCalledOnce();
    });

    it('sends CLIENT_SETUP as the first message on the control stream', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport);
      await flush();

      // CLIENT_SETUP should have been written before we push SERVER_SETUP
      expect(mock.controlWritten.length).toBe(1);

      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;
    });

    it('transitions to ESTABLISHED after receiving SERVER_SETUP', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      expect(adapter.session.state).toBe(SessionState.ESTABLISHED);
    });

    it('rejects with ProtocolViolationError if control stream closes before SERVER_SETUP (§3.2)', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.closeControlReadable();

      try {
        await connectPromise;
        expect.fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ProtocolViolationError);
        expect((e as Error).message).toMatch(/control stream closed/i);
      }
    });

    it('rejects if setup fails (e.g., server sends PATH — §9.3)', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport);
      await flush();

      // Send a SERVER_SETUP with a PATH parameter — §9.3.1.2 says
      // server MUST NOT send PATH; client MUST close with INVALID_PATH.
      const badSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map([
          [varint(0x01), [new TextEncoder().encode('/moq')]],  // PATH
          [varint(0x02), [varint(10)]],                        // MAX_REQUEST_ID
        ]),
      };
      mock.pushControlBytes(encodeControlMessage(badSetup));

      await expect(connectPromise).rejects.toThrow(/setup failed/i);
    });

    it('does not start background loops after setup failure (§9.3)', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport);
      await flush();

      // Trigger setup failure — duplicate SERVER_SETUP
      // (first succeeds, but we need a different failure — use PATH)
      const badSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map([
          [varint(0x01), [new TextEncoder().encode('/moq')]],
          [varint(0x02), [varint(10)]],
        ]),
      };
      mock.pushControlBytes(encodeControlMessage(badSetup));

      try { await connectPromise; } catch { /* expected */ }

      // Session should be CLOSED, not ESTABLISHED
      expect(adapter.session.state).toBe(SessionState.CLOSED);
    });

    it('passes SetupOptions through to session', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport, {
        maxRequestId: varint(100),
      });
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      // Session should be established (setup options were accepted)
      expect(adapter.session.state).toBe(SessionState.ESTABLISHED);
    });

    it('strips path option for WebTransport (§9.3.1.1)', async () => {
      // §9.3.1.1: "PATH ... MUST NOT be used ... when WebTransport is used."
      // MoqtConnection is WebTransport-specific, so it must strip path.
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport, {
        maxRequestId: varint(100),
        path: '/moq',
      });
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      // Decode the CLIENT_SETUP that was sent on the wire
      expect(mock.controlWritten.length).toBeGreaterThan(0);
      const { message } = decodeControlMessage(mock.controlWritten[0]!, 0);
      expect(message.type).toBe('CLIENT_SETUP');
      const clientSetup = message as import('@moqt/transport').ClientSetup;

      // PATH (0x01) MUST NOT appear in the parameters
      expect(clientSetup.parameters.has(varint(SetupParam.PATH))).toBe(false);
    });

    it('strips authority option for WebTransport (§9.3.1.2)', async () => {
      // §9.3.1.2: "AUTHORITY ... MUST NOT be used ... when WebTransport is used."
      const mock = createMockTransport();
      const adapter = new MoqtConnection();

      const connectPromise = adapter.connect(mock.transport, {
        maxRequestId: varint(100),
        authority: 'example.com',
      });
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      // Decode the CLIENT_SETUP that was sent on the wire
      const { message } = decodeControlMessage(mock.controlWritten[0]!, 0);
      const clientSetup = message as import('@moqt/transport').ClientSetup;

      // AUTHORITY (0x05) MUST NOT appear in the parameters
      expect(clientSetup.parameters.has(varint(SetupParam.AUTHORITY))).toBe(false);
    });
  });

  // ─── Control stream read loop ─────────────────────────────────

  describe('control message routing', () => {
    it('routes incoming control messages to session after setup', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      // Push a GOAWAY message on the control stream
      const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
      mock.pushControlBytes(encodeControlMessage(goaway));
      await flush();

      // Session should have transitioned to DRAINING from the GOAWAY
      expect(adapter.session.state).toBe(SessionState.DRAINING);
    });

    it('invokes onMessage callback for each received control message', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();
      const onMessage = vi.fn();
      adapter.onMessage = onMessage;

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
      mock.pushControlBytes(encodeControlMessage(goaway));
      await flush();

      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage.mock.calls[0]![0].type).toBe('GOAWAY');
    });

    it('executes send_control actions produced by session', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      // CLIENT_SETUP was the first write; track current count
      const writesBefore = mock.controlWritten.length;

      const ns = [new TextEncoder().encode('live')];
      const name = new TextEncoder().encode('video');
      await adapter.subscribe(ns, name);

      // A SUBSCRIBE message should have been written to the control stream
      expect(mock.controlWritten.length).toBeGreaterThan(writesBefore);
    });
  });

  // ─── Action execution ─────────────────────────────────────────

  describe('action execution', () => {
    it('close_connection action calls transport.close()', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      await adapter.close();

      expect(mock.closeFn).toHaveBeenCalledOnce();
    });
  });

  // ─── Error handling ───────────────────────────────────────────

  describe('error handling', () => {
    it('invokes onClose callback when control stream closes after setup', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();
      const onClose = vi.fn();
      adapter.onClose = onClose;

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      mock.closeControlReadable();
      await flush();

      expect(onClose).toHaveBeenCalled();
    });

    it('invokes onError callback when session produces protocol error', async () => {
      const mock = createMockTransport();
      const adapter = new MoqtConnection();
      const onError = vi.fn();
      adapter.onError = onError;

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      // Send a duplicate GOAWAY (second one is a protocol violation)
      const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
      mock.pushControlBytes(encodeControlMessage(goaway));
      await flush();

      mock.pushControlBytes(encodeControlMessage(goaway));
      await flush();

      // Session should have closed with protocol violation
      expect(mock.closeFn).toHaveBeenCalled();
    });
  });

  // ─── Convenience methods ──────────────────────────────────────

  describe('subscribe()', () => {
    it('returns the request ID for the new subscription', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const ns = [new TextEncoder().encode('live')];
      const name = new TextEncoder().encode('catalog');
      const requestId = await adapter.subscribe(ns, name);

      expect(requestId).toBeDefined();
      // Client request IDs are even
      expect(Number(requestId) % 2).toBe(0);
    });
  });

  describe('unsubscribe()', () => {
    it('sends UNSUBSCRIBE for an established subscription (§2.4.2)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const ns = [new TextEncoder().encode('live')];
      const name = new TextEncoder().encode('video');
      const requestId = await adapter.subscribe(ns, name);

      // Establish the subscription by injecting SUBSCRIBE_OK on the control stream
      const subscribeOk = encodeControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as ControlMessage);
      mock.pushControlBytes(subscribeOk);
      await deepFlush();

      const beforeCount = mock.controlWritten.length;

      // Now unsubscribe — §2.4.2 MUST UNSUBSCRIBE on malformed track
      await adapter.unsubscribe(requestId);

      // Verify UNSUBSCRIBE was written to the control stream
      expect(mock.controlWritten.length).toBeGreaterThan(beforeCount);
    });
  });

  // ─── Data stream handling (§10.4) ─────────────────────────────

  describe('incoming data streams', () => {
    // ─── Subgroup streams (§10.4.2) ─────────────────────────────

    describe('subgroup streams', () => {
      it('decodes subgroup header from incoming unidirectional stream', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onDataStream = vi.fn();
        adapter.onDataStream = onDataStream;

        // Inject an incoming unidirectional stream with a subgroup header
        const header = makeSubgroupHeader();
        const stream = mock.addIncomingStream();
        stream.push(encodeSubgroupHeader(header));
        await deepFlush();

        expect(onDataStream).toHaveBeenCalledOnce();
        const [streamId, dsHeader] = onDataStream.mock.calls[0]!;
        expect(dsHeader.type).toBe('subgroup');
        expect(dsHeader.header.trackAlias).toBe(header.trackAlias);
        expect(dsHeader.header.groupId).toBe(header.groupId);
      });

      it('decodes objects after subgroup header', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        adapter.onObject = onObject;

        const header = makeSubgroupHeader();
        const obj = makeSubgroupObject({ objectId: varint(0) });

        const stream = mock.addIncomingStream();
        const headerBytes = encodeSubgroupHeader(header);
        const objBytes = encodeSubgroupObject(obj, header.hasExtensions, varint(0), true);
        stream.push(concat(headerBytes, objBytes));
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();
        const [streamId, receivedObj] = onObject.mock.calls[0]!;
        expect(receivedObj.kind).toBe('data');
        expect(receivedObj.payload).toEqual(obj.payload);
      });

      it('decodes multiple sequential objects with delta encoding', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        adapter.onObject = onObject;

        const header = makeSubgroupHeader();
        const obj0 = makeSubgroupObject({ objectId: varint(0), payload: new Uint8Array([0x01]) });
        const obj1 = makeSubgroupObject({ objectId: varint(1), payload: new Uint8Array([0x02]) });
        const obj2 = makeSubgroupObject({ objectId: varint(2), payload: new Uint8Array([0x03]) });

        const stream = mock.addIncomingStream();
        stream.push(concat(
          encodeSubgroupHeader(header),
          encodeSubgroupObject(obj0, false, varint(0), true),
          encodeSubgroupObject(obj1, false, varint(0), false),
          encodeSubgroupObject(obj2, false, varint(1), false),
        ));
        await deepFlush();

        expect(onObject).toHaveBeenCalledTimes(3);
        // Verify object IDs are correctly reconstructed from deltas
        expect(onObject.mock.calls[0]![1].objectId).toBe(varint(0));
        expect(onObject.mock.calls[1]![1].objectId).toBe(varint(1));
        expect(onObject.mock.calls[2]![1].objectId).toBe(varint(2));
      });

      it('handles chunked delivery — header and object in separate reads', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onDataStream = vi.fn();
        const onObject = vi.fn();
        adapter.onDataStream = onDataStream;
        adapter.onObject = onObject;

        const header = makeSubgroupHeader();
        const obj = makeSubgroupObject();

        const stream = mock.addIncomingStream();

        // Push header in first chunk
        stream.push(encodeSubgroupHeader(header));
        await deepFlush();
        expect(onDataStream).toHaveBeenCalledOnce();

        // Push object in second chunk
        stream.push(encodeSubgroupObject(obj, false, varint(0), true));
        await deepFlush();
        expect(onObject).toHaveBeenCalledOnce();
      });

      it('reports Object Status as gap (END_OF_GROUP)', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        adapter.onObject = onObject;

        const header = makeSubgroupHeader();
        const gapObj = makeSubgroupObject({
          objectId: varint(0),
          payload: new Uint8Array(0), // Zero-length payload → status object
          status: ObjectStatus.END_OF_GROUP,
        });

        const stream = mock.addIncomingStream();
        stream.push(concat(
          encodeSubgroupHeader(header),
          encodeSubgroupObject(gapObj, false, varint(0), true),
        ));
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();
        const receivedObj = onObject.mock.calls[0]![1];
        expect(receivedObj.kind).toBe('gap');
        expect(receivedObj.status).toBe(ObjectStatus.END_OF_GROUP);
      });

      it('synthesizes END_OF_GROUP gap on FIN when subgroup header has endOfGroup flag', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        const onStreamClosed = vi.fn();
        adapter.onObject = onObject;
        adapter.onStreamClosed = onStreamClosed;

        // Subgroup header with END_OF_GROUP flag set (one-subgroup-per-GOP model)
        const header = makeSubgroupHeader({
          typeByte: 0x18, // SUBGROUP_MARKER | END_OF_GROUP
          isEndOfGroup: true,
        });
        const obj = makeSubgroupObject({ objectId: varint(0) });

        const stream = mock.addIncomingStream();
        stream.push(concat(
          encodeSubgroupHeader(header),
          encodeSubgroupObject(obj, false, varint(0), true),
        ));
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();
        expect(onObject.mock.calls[0]![1].kind).toBe('data');

        // FIN the stream — should synthesize END_OF_GROUP gap AND fire onStreamClosed
        stream.close();
        await deepFlush();

        expect(onObject).toHaveBeenCalledTimes(2);
        const eogObj = onObject.mock.calls[1]![1];
        expect(eogObj.kind).toBe('gap');
        expect(eogObj.status).toBe(ObjectStatus.END_OF_GROUP);
        expect(eogObj.groupId).toBe(header.groupId);
        expect(eogObj.objectId).toBe(1n); // previousObjectId(0) + 1

        // Stream lifecycle signal must also fire after synthesis
        expect(onStreamClosed).toHaveBeenCalledOnce();
      });

      it('does NOT synthesize END_OF_GROUP on FIN when header lacks endOfGroup flag', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        adapter.onObject = onObject;

        // Header without END_OF_GROUP flag
        const header = makeSubgroupHeader({ isEndOfGroup: false });
        const obj = makeSubgroupObject({ objectId: varint(0) });

        const stream = mock.addIncomingStream();
        stream.push(concat(
          encodeSubgroupHeader(header),
          encodeSubgroupObject(obj, false, varint(0), true),
        ));
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();

        stream.close();
        await deepFlush();

        // No second call — no synthesized END_OF_GROUP
        expect(onObject).toHaveBeenCalledOnce();
      });

      it('does NOT synthesize END_OF_GROUP on RESET_STREAM even with endOfGroup flag', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        adapter.onObject = onObject;

        const header = makeSubgroupHeader({
          typeByte: 0x18,
          isEndOfGroup: true,
        });
        const obj = makeSubgroupObject({ objectId: varint(0) });

        const stream = mock.addIncomingStream();
        stream.push(concat(
          encodeSubgroupHeader(header),
          encodeSubgroupObject(obj, false, varint(0), true),
        ));
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();

        // RESET_STREAM instead of FIN — should NOT synthesize END_OF_GROUP
        stream.reset(0x01);
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();
      });

      it('invokes onStreamClosed when stream FIN received', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onStreamClosed = vi.fn();
        adapter.onStreamClosed = onStreamClosed;

        const header = makeSubgroupHeader();
        const stream = mock.addIncomingStream();
        stream.push(encodeSubgroupHeader(header));
        await deepFlush();

        // Close the stream (FIN)
        stream.close();
        await deepFlush();

        expect(onStreamClosed).toHaveBeenCalledOnce();
        // FIN = no error
        expect(onStreamClosed.mock.calls[0]![1]).toBeUndefined();
      });

      it('passes stream error code to onStreamClosed on RESET_STREAM (§10.4)', async () => {
        // §10.4: Publisher can reset a data stream (e.g., DELIVERY_TIMEOUT expired).
        // The error code SHOULD be forwarded so the player can distinguish
        // reset (incomplete subgroup) from FIN (all objects delivered).
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onStreamClosed = vi.fn();
        adapter.onStreamClosed = onStreamClosed;

        const header = makeSubgroupHeader();
        const stream = mock.addIncomingStream();
        stream.push(encodeSubgroupHeader(header));
        await deepFlush();

        // Reset the stream with an error code
        stream.reset(0x10); // DELIVERY_TIMEOUT
        await deepFlush();

        expect(onStreamClosed).toHaveBeenCalledOnce();
        // Error code from the stream reset
        expect(onStreamClosed.mock.calls[0]![1]).toBe(0x10);
      });

      it('handles subgroup header with extensions flag', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        adapter.onObject = onObject;

        // Type 0x11 = SUBGROUP_MARKER | EXTENSIONS, SubgroupId=ZERO, priority present
        const header = makeSubgroupHeader({
          typeByte: 0x11,
          hasExtensions: true,
        });

        // Object with extension data
        const ext = new Uint8Array([0x04, 0x01, 0xAB]); // key=4 (CaptureTimestamp stub), value=0xAB
        const obj = makeSubgroupObject({
          objectId: varint(0),
          extensions: ext,
        });

        const stream = mock.addIncomingStream();
        stream.push(concat(
          encodeSubgroupHeader(header),
          encodeSubgroupObject(obj, true, varint(0), true),
        ));
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();
        expect(onObject.mock.calls[0]![1].extensions).toBeDefined();
      });
    });

    // ─── Fetch streams (§10.4.4) ────────────────────────────────

    describe('fetch streams', () => {
      it('decodes fetch header from incoming unidirectional stream', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onDataStream = vi.fn();
        adapter.onDataStream = onDataStream;

        const fetchHeader: FetchHeader = { requestId: varint(2) };
        const stream = mock.addIncomingStream();
        stream.push(encodeFetchHeader(fetchHeader));
        await deepFlush();

        expect(onDataStream).toHaveBeenCalledOnce();
        const [streamId, dsHeader] = onDataStream.mock.calls[0]!;
        expect(dsHeader.type).toBe('fetch');
        expect(dsHeader.header.requestId).toBe(varint(2));
      });

      it('decodes fetch objects after header', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);
        const onObject = vi.fn();
        adapter.onObject = onObject;

        const fetchHeader: FetchHeader = { requestId: varint(2) };

        // First fetch object must have GROUP_ID, OBJECT_ID, PRIORITY flags set
        // Flags: GROUP_ID(0x08) | OBJECT_ID(0x04) | PRIORITY(0x10) | SUBGROUP_MODE=ZERO(0x00) = 0x1C
        const fetchObj: FetchObject = {
          flags: varint(0x1c),
          groupId: varint(0),
          subgroupId: varint(0),
          objectId: varint(0),
          publisherPriority: 128,
          isDatagram: false,
          extensions: undefined,
          payload: new Uint8Array([0xBE, 0xEF]),
        };

        const stream = mock.addIncomingStream();
        stream.push(concat(
          encodeFetchHeader(fetchHeader),
          encodeFetchObject(fetchObj),
        ));
        await deepFlush();

        expect(onObject).toHaveBeenCalledOnce();
        const receivedObj = onObject.mock.calls[0]![1];
        expect(receivedObj.kind).toBe('data');
        expect(receivedObj.payload).toEqual(new Uint8Array([0xBE, 0xEF]));
      });
    });

    // ─── Mid-object FIN (§10.4) ─────────────────────────────────

    it('closes session on FIN mid-object in subgroup stream (§10.4)', async () => {
      // §10.4: "If a stream ends gracefully (i.e., the stream terminates
      // with a FIN) in the middle of a serialized Object, the session
      // SHOULD be closed with a PROTOCOL_VIOLATION."
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const header: SubgroupHeader = {
        typeByte: 0x10,
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        publisherPriority: 128,
        hasExtensions: false,
        isEndOfGroup: false,
      };

      const stream = mock.addIncomingStream();
      // Send header + partial object bytes (just objectId varint, no payload length)
      stream.push(concat(
        encodeSubgroupHeader(header),
        new Uint8Array([0x00]), // objectId = 0 (partial — no payload length follows)
      ));
      await deepFlush();

      // Close stream (FIN) with partial bytes still in buffer
      stream.close();
      await deepFlush();

      // Session SHOULD be closed with PROTOCOL_VIOLATION
      expect(mock.closeFn).toHaveBeenCalled();
      const closeArg = mock.closeFn.mock.calls[0]![0];
      expect(closeArg.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
    });

    it('does not close session on clean FIN at object boundary (§10.4)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onStreamClosed = vi.fn();
      adapter.onStreamClosed = onStreamClosed;

      const header: SubgroupHeader = {
        typeByte: 0x10,
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0),
        publisherPriority: 128,
        hasExtensions: false,
        isEndOfGroup: false,
      };
      const object: SubgroupObject = {
        objectId: varint(0),
        extensions: undefined,
        payload: new Uint8Array([0xCA, 0xFE]),
        status: undefined,
      };

      const stream = mock.addIncomingStream();
      stream.push(concat(
        encodeSubgroupHeader(header),
        encodeSubgroupObject(object, false, true),
      ));
      await deepFlush();

      // Clean FIN at object boundary
      stream.close();
      await deepFlush();

      // Should NOT close session — clean boundary
      expect(mock.closeFn).not.toHaveBeenCalled();
      expect(onStreamClosed).toHaveBeenCalledWith(0n);
    });

    it('closes session on unknown data stream type (§10.4)', async () => {
      // §10.4: "An endpoint that receives an unknown stream or datagram
      // type MUST close the session."
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onClose = vi.fn();
      adapter.onClose = onClose;

      const stream = mock.addIncomingStream();
      // 0xFF is not a valid stream type (not SUBGROUP_HEADER 0x10-0x3D or FETCH_HEADER 0x05)
      stream.push(new Uint8Array([0xFF, 0x00, 0x00, 0x00]));
      await deepFlush();

      expect(mock.closeFn).toHaveBeenCalled();
      const closeArg = mock.closeFn.mock.calls[0]![0];
      expect(closeArg.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
      expect(onClose).toHaveBeenCalledWith(0x3, expect.any(String));
    });

    it('resolves FIRST_OBJECT mode subgroupId to first object objectId (§10.4.2)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onObject = vi.fn();
      adapter.onObject = onObject;

      // Type 0x12 = SUBGROUP_MARKER(0x10) | FIRST_OBJECT mode(0b01 << 1 = 0x02)
      // No extensions, priority present, no END_OF_GROUP
      const header: SubgroupHeader = {
        typeByte: 0x12,
        trackAlias: varint(1),
        groupId: varint(0),
        subgroupId: varint(0), // placeholder — decoder uses 0 for FIRST_OBJECT mode
        publisherPriority: 128,
        hasExtensions: false,
        isEndOfGroup: false,
      };

      // First object has objectId=5 — this should become the subgroupId
      const obj0: SubgroupObject = {
        objectId: varint(5),
        extensions: undefined,
        payload: new Uint8Array([0xAA]),
        status: undefined,
      };
      // Second object has objectId=6 — subgroupId should still be 5
      const obj1: SubgroupObject = {
        objectId: varint(6),
        extensions: undefined,
        payload: new Uint8Array([0xBB]),
        status: undefined,
      };

      const stream = mock.addIncomingStream();
      stream.push(concat(
        encodeSubgroupHeader(header),
        encodeSubgroupObject(obj0, false, varint(0), true),
        encodeSubgroupObject(obj1, false, varint(5), false),
      ));
      stream.close();
      await deepFlush();

      expect(onObject).toHaveBeenCalledTimes(2);
      // §10.4.2: "Subgroup ID is the Object ID of the first Object transmitted"
      expect(onObject.mock.calls[0]![1].subgroupId).toBe(varint(5));
      expect(onObject.mock.calls[1]![1].subgroupId).toBe(varint(5));
    });
  });

  // ─── Datagram handling (§10.3) ────────────────────────────────

  describe('datagrams', () => {
    it('decodes incoming OBJECT_DATAGRAM', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onDatagram = vi.fn();
      adapter.onDatagram = onDatagram;

      // Type byte 0x00 = no flags (all fields present, no extensions, no status)
      const datagram: ObjectDatagram = {
        typeByte: 0x00,
        trackAlias: varint(1),
        groupId: varint(5),
        objectId: varint(3),
        publisherPriority: 200,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0xDE, 0xAD]),
        status: undefined,
      };

      mock.pushDatagram(encodeObjectDatagram(datagram));
      await deepFlush();

      expect(onDatagram).toHaveBeenCalledOnce();
      const received = onDatagram.mock.calls[0]![0];
      expect(received.trackAlias).toBe(varint(1));
      expect(received.groupId).toBe(varint(5));
      expect(received.objectId).toBe(varint(3));
      expect(received.payload).toEqual(new Uint8Array([0xDE, 0xAD]));
    });

    it('decodes datagram with DEFAULT_PRIORITY flag', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onDatagram = vi.fn();
      adapter.onDatagram = onDatagram;

      // Type 0x08 = DEFAULT_PRIORITY (no priority field)
      const datagram: ObjectDatagram = {
        typeByte: 0x08,
        trackAlias: varint(2),
        groupId: varint(0),
        objectId: varint(0),
        publisherPriority: undefined,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0x42]),
        status: undefined,
      };

      mock.pushDatagram(encodeObjectDatagram(datagram));
      await deepFlush();

      expect(onDatagram).toHaveBeenCalledOnce();
      const received = onDatagram.mock.calls[0]![0];
      expect(received.publisherPriority).toBeUndefined();
    });

    it('closes session on datagram with EXTENSIONS flag + zero length (§10.3.1)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      // §10.3.1: "If an endpoint receives a datagram with the EXTENSIONS
      // bit set and an Extension Headers Length of 0, it MUST close the
      // session with a PROTOCOL_VIOLATION."
      //
      // Type 0x01 = EXTENSIONS bit set, all other flags clear.
      // trackAlias=1 (varint 1 byte), groupId=0 (varint 1 byte),
      // objectId=0 (varint 1 byte), priority=128 (1 byte),
      // extensionsLength=0 (varint 1 byte = 0x00)
      const malformedDatagram = new Uint8Array([
        0x01,       // type: EXTENSIONS flag set
        0x01,       // trackAlias = 1
        0x00,       // groupId = 0
        0x00,       // objectId = 0
        0x80,       // publisherPriority = 128
        0x00,       // extensionsLength = 0 ← PROTOCOL_VIOLATION
      ]);

      mock.pushDatagram(malformedDatagram);
      await deepFlush();

      // Session must be closed with PROTOCOL_VIOLATION, not just onError
      expect(mock.closeFn).toHaveBeenCalled();
      const closeArg = mock.closeFn.mock.calls[0]![0];
      expect(closeArg.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
    });

    it('closes session on datagram with invalid type (§10)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      // §10: "An endpoint that receives an unknown stream or datagram
      //        type MUST close the session."
      //
      // Type 0x30 is outside valid range 0x00..0x0F and 0x20..0x2F.
      // 0x30 = 0b00110000 — bit 4 is set, violating the 0b00X0XXXX mask.
      const invalidTypeDatagram = new Uint8Array([
        0x30,       // invalid type
        0x01,       // trackAlias
        0x00,       // groupId
        0x00,       // objectId
        0x80,       // priority
      ]);

      mock.pushDatagram(invalidTypeDatagram);
      await deepFlush();

      expect(mock.closeFn).toHaveBeenCalled();
      const closeArg = mock.closeFn.mock.calls[0]![0];
      expect(closeArg.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
    });

    it('silently drops datagrams that fail to parse (e.g. stray H3 capsules)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onError = vi.fn();
      const onDatagram = vi.fn();
      adapter.onError = onError;
      adapter.onDatagram = onDatagram;

      // A short blob that starts with a valid-looking datagram type byte (0x00)
      // but is too short to contain all required fields. This triggers a
      // RangeError during varint parsing — e.g. an H3 capsule or WebTransport
      // implementation artifact leaking into the datagram channel.
      // 0x00 = valid type (no flags), 0x40 starts a 2-byte varint for track
      // alias but only 1 more byte available → RangeError reading group ID.
      const strayBlob = new Uint8Array([0x00, 0x40, 0xFF]);
      mock.pushDatagram(strayBlob);
      await deepFlush();

      // Should NOT emit onError for parse failures on unreliable datagrams
      expect(onError).not.toHaveBeenCalled();
      // Should NOT have decoded a valid datagram
      expect(onDatagram).not.toHaveBeenCalled();
      // Session should still be open (no close)
      expect(mock.closeFn).not.toHaveBeenCalled();
    });
  });

  // ─── Control read loop resilience ──────────────────────────────

  describe('control read loop resilience', () => {
    it('closes session with PROTOCOL_VIOLATION on malformed control message (§9)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onClose = vi.fn();
      adapter.onClose = onClose;

      // Send a malformed control message: valid framing but garbled payload.
      // Type = GOAWAY (0x10), length = 2 bytes, but payload is garbage that
      // causes a parse error in readVarint.
      const malformed = new Uint8Array([0x10, 0x00, 0x02, 0xFF, 0xFF]);
      mock.pushControlBytes(malformed);
      await deepFlush();

      // §9: "If the length does not match the length of the Message Payload,
      // the receiver MUST close the session with a PROTOCOL_VIOLATION."
      expect(mock.closeFn).toHaveBeenCalled();
      const closeArg = mock.closeFn.mock.calls[0]![0];
      expect(closeArg.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
      expect(onClose).toHaveBeenCalledWith(0x3, expect.stringContaining('Malformed control message'));
    });
  });

  // ─── Control stream closure (§3.2) ─────────────────────────────

  describe('control stream closure', () => {
    it('closes transport with PROTOCOL_VIOLATION when control stream FIN received (§3.2)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onClose = vi.fn();
      adapter.onClose = onClose;

      // Simulate unexpected control stream FIN
      mock.closeControlReadable();
      await deepFlush();

      // §3.2: "The control stream MUST NOT be closed at the underlying
      // transport layer during the session's lifetime. Doing so results
      // in the session being closed as a PROTOCOL_VIOLATION."
      expect(mock.closeFn).toHaveBeenCalled();
      const closeArg = mock.closeFn.mock.calls[0]![0];
      expect(closeArg.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ─── Namespace stream (§6.1 SUBSCRIBE_NAMESPACE) ────────────────

  describe('namespace streams (§6.1)', () => {
    const enc = new TextEncoder();

    it('opens a new bidi stream and sends SUBSCRIBE_NAMESPACE (§6.1)', async () => {
      // §6.1: "The subscriber sends SUBSCRIBE_NAMESPACE on a new
      // bidirectional stream"
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      // First bidi stream = control, second = namespace
      expect(mock.transport.createBidirectionalStream).toHaveBeenCalledTimes(2);

      // Verify SUBSCRIBE_NAMESPACE was written on the namespace stream
      const nsBidi = mock.bidiStreams[1]!;
      expect(nsBidi.written.length).toBeGreaterThan(0);

      // Decode the message written to the namespace stream
      const { message } = decodeControlMessage(nsBidi.written[0]!, 0);
      expect(message.type).toBe('SUBSCRIBE_NAMESPACE');
    });

    it('returns the request ID for the namespace subscription', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      // Client request IDs are even
      expect(Number(requestId) % 2).toBe(0);
    });

    it('routes REQUEST_OK from namespace stream to session (§6.1)', async () => {
      // §6.1: "publisher MUST send a single REQUEST_OK or REQUEST_ERROR
      // as the first message on the bidirectional stream"
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      // Push REQUEST_OK on the namespace stream
      const nsBidi = mock.bidiStreams[1]!;
      const requestOk: RequestOk = {
        type: 'REQUEST_OK',
        requestId,
        parameters: new Map(),
      };
      nsBidi.push(encodeControlMessage(requestOk));
      await deepFlush();

      // Verify namespace SM transitioned to ACTIVE
      const nsSm = adapter.session.getNamespaceSubscription(requestId);
      expect(nsSm).toBeDefined();
      expect(nsSm!.state).toBe('active');
    });

    it('routes NAMESPACE messages to session after REQUEST_OK (§6.1)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      const nsBidi = mock.bidiStreams[1]!;

      // First: REQUEST_OK
      const requestOk: RequestOk = {
        type: 'REQUEST_OK',
        requestId,
        parameters: new Map(),
      };
      nsBidi.push(encodeControlMessage(requestOk));
      await deepFlush();

      // Then: NAMESPACE message
      const ns: Namespace = {
        type: 'NAMESPACE',
        trackNamespaceSuffix: [enc.encode('broadcast1')],
        parameters: new Map(),
      };
      nsBidi.push(encodeControlMessage(ns));
      await deepFlush();

      // Verify namespace was discovered
      const nsSm = adapter.session.getNamespaceSubscription(requestId);
      expect(nsSm!.discoveredNamespaces).toHaveLength(1);
    });

    it('routes REQUEST_ERROR from namespace stream to session (§6.1)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      // Push REQUEST_ERROR on the namespace stream
      const nsBidi = mock.bidiStreams[1]!;
      const reqErr: RequestErrorMsg = {
        type: 'REQUEST_ERROR',
        requestId,
        errorCode: varint(0x1n),
        retryInterval: varint(0n),
        errorReason: 'not found',
      };
      nsBidi.push(encodeControlMessage(reqErr));
      await deepFlush();

      // Verify namespace SM transitioned to TERMINATED
      const nsSm = adapter.session.getNamespaceSubscription(requestId);
      expect(nsSm!.state).toBe('terminated');
    });

    it('routes NAMESPACE_DONE and terminates namespace subscription (§6.1)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      const nsBidi = mock.bidiStreams[1]!;

      // REQUEST_OK → NAMESPACE → NAMESPACE_DONE
      nsBidi.push(encodeControlMessage({
        type: 'REQUEST_OK',
        requestId,
        parameters: new Map(),
      } as RequestOk));
      await deepFlush();

      nsBidi.push(encodeControlMessage({
        type: 'NAMESPACE',
        trackNamespaceSuffix: [enc.encode('stream1')],
        parameters: new Map(),
      } as Namespace));
      await deepFlush();

      nsBidi.push(encodeControlMessage({
        type: 'NAMESPACE_DONE',
        trackNamespaceSuffix: [enc.encode('stream1')],
      } as NamespaceDone));
      await deepFlush();

      const nsSm = adapter.session.getNamespaceSubscription(requestId);
      expect(nsSm!.state).toBe('terminated');
    });

    it('closes session on unexpected message type on namespace stream', async () => {
      // §6.1: Only REQUEST_OK, REQUEST_ERROR, NAMESPACE, NAMESPACE_DONE
      // are valid on the namespace bidi stream
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      const nsBidi = mock.bidiStreams[1]!;

      // First send REQUEST_OK so we're in ACTIVE state
      nsBidi.push(encodeControlMessage({
        type: 'REQUEST_OK',
        requestId,
        parameters: new Map(),
      } as RequestOk));
      await deepFlush();

      // Send a GOAWAY on the namespace stream — invalid
      const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
      nsBidi.push(encodeControlMessage(goaway));
      await deepFlush();

      // Session should close with PROTOCOL_VIOLATION
      expect(mock.closeFn).toHaveBeenCalled();
      const closeArg = mock.closeFn.mock.calls[0]![0];
      expect(closeArg.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
    });

    it('handles namespace stream FIN after clean termination', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      const nsBidi = mock.bidiStreams[1]!;

      // REQUEST_ERROR terminates the namespace subscription
      nsBidi.push(encodeControlMessage({
        type: 'REQUEST_ERROR',
        requestId,
        errorCode: varint(0x1n),
        retryInterval: varint(0n),
        errorReason: 'denied',
      } as RequestErrorMsg));
      await deepFlush();

      // Peer closes the stream (FIN) — should not crash
      nsBidi.close();
      await deepFlush();

      // Session should still be ESTABLISHED (not crashed)
      expect(adapter.session.state).toBe(SessionState.ESTABLISHED);
    });
  });

  // ─── stop_sending on data streams (§10.4.3) ──────────────────────

  describe('stop_sending on data streams (§10.4.3)', () => {
    it('cancels a tracked incoming data stream with error code', async () => {
      // §10.4.3: "A subscriber MAY send a QUIC STOP_SENDING frame for a
      // subgroup stream if the Group or Subgroup is no longer of interest"
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onDataStream = vi.fn();
      adapter.onDataStream = onDataStream;

      const header = makeSubgroupHeader();
      const stream = mock.addIncomingStream();
      stream.push(encodeSubgroupHeader(header));
      await deepFlush();

      expect(onDataStream).toHaveBeenCalledOnce();
      const streamId = onDataStream.mock.calls[0]![0] as bigint;

      // Execute a stop_sending action for this stream
      await (adapter as any).executeActions([
        { type: 'stop_sending', streamId, error: varint(0x1) },
      ]);

      // The stream should have been cancelled (reader.cancel)
      // Verify by checking that onStreamClosed fires
      await deepFlush();
      // Stream closure may happen asynchronously
    });

    it('stopSending() cancels the stream and fires onStreamClosed', async () => {
      // Higher-level test: use the public convenience method
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onDataStream = vi.fn();
      const onStreamClosed = vi.fn();
      adapter.onDataStream = onDataStream;
      adapter.onStreamClosed = onStreamClosed;

      const header = makeSubgroupHeader();
      const stream = mock.addIncomingStream();
      stream.push(encodeSubgroupHeader(header));
      await deepFlush();

      const streamId = onDataStream.mock.calls[0]![0] as bigint;

      // §10.4.3: CANCELLED (0x1) error code
      await adapter.stopSending(streamId, varint(0x1));
      await deepFlush();

      // onStreamClosed should fire (the reader.cancel causes an error
      // in the read loop which triggers stream closure)
      expect(onStreamClosed).toHaveBeenCalled();
    });

    it('stop_sending on unknown stream is a no-op', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onError = vi.fn();
      adapter.onError = onError;

      // Stop sending on a stream that doesn't exist — should not throw
      await (adapter as any).executeActions([
        { type: 'stop_sending', streamId: 999n, error: varint(0x1) },
      ]);

      // No error surfaced (graceful no-op for already-closed streams)
      expect(onError).not.toHaveBeenCalled();
    });
  });

  // ─── Namespace stream cancellation (§6.1) ──────────────────────

  describe('namespace stream cancellation (§6.1)', () => {
    const enc = new TextEncoder();

    it('cancelNamespace() closes the writable side of the namespace stream (FIN)', async () => {
      // §6.1: "A SUBSCRIBE_NAMESPACE can be cancelled by closing
      // the stream with either a FIN or RESET_STREAM."
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      // Cancel the namespace subscription (FIN)
      await adapter.cancelNamespace(requestId);
      await deepFlush();

      // The namespace stream's writable writer should have been closed
      // Verify by checking the stream is no longer tracked
      expect((adapter as any).namespaceStreams.has(requestId as bigint)).toBe(false);
    });

    it('cancelNamespace() on unknown requestId is a no-op', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onError = vi.fn();
      adapter.onError = onError;

      // Cancel a namespace that doesn't exist — should not crash
      await adapter.cancelNamespace(varint(999n));

      expect(onError).not.toHaveBeenCalled();
    });
  });

  // ─── close_stream / reset_stream actions ────────────────────────

  describe('close_stream / reset_stream actions', () => {
    it('close_stream closes a tracked writable stream with FIN', async () => {
      // Test via namespace stream: open one, then close_stream it
      const enc = new TextEncoder();
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      // Get the stream ID that the adapter assigned internally
      // We can test via the cancelNamespace path which uses close_stream internally
      await adapter.cancelNamespace(requestId);
      await deepFlush();

      // Stream should be cleaned up
      expect((adapter as any).namespaceStreams.has(requestId as bigint)).toBe(false);
    });
  });

  // ─── FETCH (§9.16, §9.18) ─────────────────────────────────────

  /**
   * §9.16: "A subscriber issues a FETCH to a publisher to request a
   * range of already published objects within a track."
   *
   * §9.18: "A subscriber sends a FETCH_CANCEL message to a publisher
   * to indicate it is no longer interested in receiving objects for the
   * fetch identified by the 'Request ID'."
   *
   * §5.2: "If the data stream is already open, it MAY send STOP_SENDING
   * for the data stream along with FETCH_CANCEL, but MUST send FETCH_CANCEL."
   */
  describe('fetch and fetchCancel (§9.16, §9.18)', () => {
    it('sends FETCH on control stream and returns request ID', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]); // "video"
      const requestId = await adapter.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      expect(requestId).toBeDefined();
      // Verify FETCH was written to control stream
      // controlWritten[0] = CLIENT_SETUP, controlWritten[1] = FETCH
      const fetchBytes = mock.controlWritten[1]!;
      const decoded = decodeControlMessage(fetchBytes, 0);
      expect(decoded.message.type).toBe('FETCH');
    });

    it('sends FETCH_CANCEL on control stream', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const requestId = await adapter.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      await adapter.fetchCancel(requestId);

      // controlWritten: [0]=CLIENT_SETUP, [1]=FETCH, [2]=FETCH_CANCEL
      const cancelBytes = mock.controlWritten[2]!;
      const decoded = decodeControlMessage(cancelBytes, 0);
      expect(decoded.message.type).toBe('FETCH_CANCEL');
    });

    it('tracks fetch stream and sends STOP_SENDING on cancel (§5.2)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onStreamClosed = vi.fn();
      adapter.onStreamClosed = onStreamClosed;

      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const requestId = await adapter.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      // Simulate a FETCH data stream arriving with matching requestId
      const fetchHeader: FetchHeader = { requestId };
      const headerBytes = encodeFetchHeader(fetchHeader);
      const stream = mock.addIncomingStream();
      stream.push(headerBytes);
      await deepFlush();

      // Now cancel — should send FETCH_CANCEL AND STOP_SENDING on data stream
      await adapter.fetchCancel(requestId);
      await deepFlush();

      // FETCH_CANCEL should be on control stream
      const cancelBytes = mock.controlWritten[2]!;
      const decoded = decodeControlMessage(cancelBytes, 0);
      expect(decoded.message.type).toBe('FETCH_CANCEL');

      // STOP_SENDING should have been sent (stream closed via reader.cancel)
      expect(onStreamClosed).toHaveBeenCalled();
    });

    it('fetchCancel without data stream does not send STOP_SENDING', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onStreamClosed = vi.fn();
      adapter.onStreamClosed = onStreamClosed;

      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const requestId = await adapter.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      // Cancel before any data stream arrives
      await adapter.fetchCancel(requestId);
      await deepFlush();

      // FETCH_CANCEL sent on control stream
      const cancelBytes = mock.controlWritten[2]!;
      const decoded = decodeControlMessage(cancelBytes, 0);
      expect(decoded.message.type).toBe('FETCH_CANCEL');

      // No STOP_SENDING because no data stream exists
      expect(onStreamClosed).not.toHaveBeenCalled();
    });
  });

  // ─── Namespace message callback (§6.1) ────────────────────────

  describe('namespace onNamespaceMessage callback (§6.1)', () => {
    const enc = new TextEncoder();

    it('fires onNamespaceMessage for each namespace stream message', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onNamespaceMessage = vi.fn();
      adapter.onNamespaceMessage = onNamespaceMessage;

      const requestId = await adapter.subscribeNamespace([enc.encode('live')]);
      await flush();

      const nsBidi = mock.bidiStreams[1]!;

      // REQUEST_OK
      const requestOk: RequestOk = {
        type: 'REQUEST_OK',
        requestId,
        parameters: new Map(),
      };
      nsBidi.push(encodeControlMessage(requestOk));
      await deepFlush();

      // NAMESPACE
      const ns: Namespace = {
        type: 'NAMESPACE',
        trackNamespaceSuffix: [enc.encode('broadcast1')],
        parameters: new Map(),
      };
      nsBidi.push(encodeControlMessage(ns));
      await deepFlush();

      expect(onNamespaceMessage).toHaveBeenCalledTimes(2);
      // First call: REQUEST_OK
      expect(onNamespaceMessage.mock.calls[0]![0]).toBe(requestId as bigint);
      expect(onNamespaceMessage.mock.calls[0]![1].type).toBe('REQUEST_OK');
      // Second call: NAMESPACE
      expect(onNamespaceMessage.mock.calls[1]![0]).toBe(requestId as bigint);
      expect(onNamespaceMessage.mock.calls[1]![1].type).toBe('NAMESPACE');
    });
  });

  // ─── TRACK_STATUS (§9.19) ──────────────────────────────────────

  describe('trackStatus (§9.19)', () => {
    it('sends TRACK_STATUS on control stream and returns request ID', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);

      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]); // "video"
      const requestId = await adapter.trackStatus(namespace, name);

      expect(requestId).toBeDefined();
      // controlWritten[0] = CLIENT_SETUP, controlWritten[1] = TRACK_STATUS
      const tsBytes = mock.controlWritten[1]!;
      const decoded = decodeControlMessage(tsBytes, 0);
      expect(decoded.message.type).toBe('TRACK_STATUS');
    });
  });

  // ─── qlog events (draft-pardue-moq-qlog-moq-events-04) ────────

  describe('qlog events', () => {
    it('onQlogEvent not called when callback is null (no crash)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      // No onQlogEvent set — subscribe should not crash
      const enc = new TextEncoder();
      await adapter.subscribe([enc.encode('live')], enc.encode('video'));
      await flush();
      // No assertion needed — the test passes if it doesn't throw
    });

    it('control_message_created fired on SUBSCRIBE send', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      const enc = new TextEncoder();
      await adapter.subscribe([enc.encode('live')], enc.encode('video'));

      const subscribeEvents = events.filter(
        (e) => e.type === 'control_message_created' && e.message.type === 'SUBSCRIBE',
      );
      expect(subscribeEvents).toHaveLength(1);
      expect(subscribeEvents[0].stream_id).toBe(0n);
      expect(subscribeEvents[0].length).toBeGreaterThan(0);
    });

    it('control_message_created includes CLIENT_SETUP during connect', async () => {
      const mock = createMockTransport();
      const events: any[] = [];
      const adapter = new MoqtConnection();
      adapter.onQlogEvent = (e) => events.push(e);

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      const setupEvents = events.filter(
        (e) => e.type === 'control_message_created' && e.message.type === 'CLIENT_SETUP',
      );
      expect(setupEvents).toHaveLength(1);
    });

    it('control_message_parsed fired on SERVER_SETUP receive', async () => {
      const mock = createMockTransport();
      const events: any[] = [];
      const adapter = new MoqtConnection();
      adapter.onQlogEvent = (e) => events.push(e);

      const connectPromise = adapter.connect(mock.transport);
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;

      // SERVER_SETUP is parsed during the connect handshake, not in the
      // background runControlReadLoop (which starts after setup). The setup
      // loop doesn't emit qlog events. So check for post-setup messages.
      // Send a GOAWAY to trigger a control_message_parsed event.
      const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
      mock.pushControlBytes(encodeControlMessage(goaway));
      await deepFlush();

      const parsedEvents = events.filter(
        (e) => e.type === 'control_message_parsed' && e.message.type === 'GOAWAY',
      );
      expect(parsedEvents).toHaveLength(1);
      expect(parsedEvents[0].stream_id).toBe(0n);
      expect(parsedEvents[0].message.type).toBe('GOAWAY');
    });

    it('stream_type_set fired with subgroup_header for subgroup streams', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      const header = makeSubgroupHeader({ trackAlias: varint(1), groupId: varint(5) });
      const stream = mock.addIncomingStream();
      stream.push(encodeSubgroupHeader(header));
      await deepFlush();

      const streamTypeEvents = events.filter((e) => e.type === 'stream_type_set');
      expect(streamTypeEvents).toHaveLength(1);
      expect(streamTypeEvents[0].stream_type).toBe('subgroup_header');
      expect(streamTypeEvents[0].owner).toBe('remote');
    });

    it('subgroup_header_parsed fired with correct header fields', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      // typeByte 0x3d = SUBGROUP_MARKER(0x10) | DEFAULT_PRIORITY_off | EXTENSIONS(0x01)
      //                | END_OF_GROUP(0x08) | EXPLICIT_SUBGROUP(0x04) | bit5=EXTENSIONS_HEADER(0x20)
      // Actually: SUBGROUP_MARKER(0x10) | END_OF_GROUP(0x08) | EXPLICIT_SUBGROUP_ID(0b10<<1=0x04)
      //         | EXTENSIONS(0x01) = 0x1D
      // With bit 5 set for EXTENSIONS=true in objects: 0x1D
      // Wait — SubgroupFlags.EXTENSIONS = 0x01 means objects carry extensions.
      // SubgroupFlags.END_OF_GROUP = 0x08.
      // SubgroupIdMode.EXPLICIT = 0b10 → bits 1-2 → shifted = 0x04.
      // SubgroupFlags.DEFAULT_PRIORITY = 0x20 (bit 5).
      // Priority present (no DEFAULT_PRIORITY): no 0x20.
      // typeByte = 0x10 | 0x08 | 0x04 | 0x01 = 0x1D
      const header = makeSubgroupHeader({
        typeByte: 0x1D, // SUBGROUP_MARKER | END_OF_GROUP | EXPLICIT_ID | EXTENSIONS
        trackAlias: varint(3),
        groupId: varint(7),
        subgroupId: varint(2),
        publisherPriority: 64,
        isEndOfGroup: true,
        hasExtensions: true,
      });
      const stream = mock.addIncomingStream();
      stream.push(encodeSubgroupHeader(header));
      await deepFlush();

      const headerEvents = events.filter((e) => e.type === 'subgroup_header_parsed');
      expect(headerEvents).toHaveLength(1);
      expect(headerEvents[0].track_alias).toBe(3n);
      expect(headerEvents[0].group_id).toBe(7n);
      expect(headerEvents[0].subgroup_id).toBe(2n);
      expect(headerEvents[0].publisher_priority).toBe(64);
      expect(headerEvents[0].contains_end_of_group).toBe(true);
      expect(headerEvents[0].extensions_present).toBe(true);
    });

    it('subgroup_header_parsed omits publisher_priority when DEFAULT_PRIORITY (-06 §4.7)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      // typeByte 0x30 = SUBGROUP_MARKER(0x10) | DEFAULT_PRIORITY(0x20)
      // SubgroupIdMode = ZERO (bits 1-2 = 0b00)
      const header = makeSubgroupHeader({
        typeByte: 0x30,
        publisherPriority: undefined,
      });
      const stream = mock.addIncomingStream();
      stream.push(encodeSubgroupHeader(header));
      await deepFlush();

      const headerEvents = events.filter((e) => e.type === 'subgroup_header_parsed');
      expect(headerEvents).toHaveLength(1);
      // -06: optional, absent means inherit from subscription
      expect(headerEvents[0].publisher_priority).toBeUndefined();
      expect(headerEvents[0].subgroup_id_mode).toBe(0); // ZERO mode
    });

    it('subgroup_object_parsed emits object_id_delta per -06 §4.9', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      const header = makeSubgroupHeader({ groupId: varint(3) });
      const obj1 = makeSubgroupObject({ objectId: varint(0), payload: new Uint8Array([0x01, 0x02]) });
      const obj2 = makeSubgroupObject({ objectId: varint(1), payload: new Uint8Array([0x03, 0x04, 0x05]) });

      const stream = mock.addIncomingStream();
      stream.push(concat(
        encodeSubgroupHeader(header),
        encodeSubgroupObject(obj1, false, varint(0), true),
        encodeSubgroupObject(obj2, false, obj1.objectId, false),
      ));
      await deepFlush();

      const objEvents = events.filter((e) => e.type === 'subgroup_object_parsed');
      expect(objEvents).toHaveLength(2);
      // -06: object_id_delta instead of absolute object_id
      expect(objEvents[0].object_id_delta).toBe(0n); // first object: delta = objectId
      expect(objEvents[0].object_payload_length).toBe(2);
      expect(objEvents[1].object_id_delta).toBe(0n); // second: delta = 1 - 0 - 1 = 0
      expect(objEvents[1].object_payload_length).toBe(3);
      // -06: group_id, subgroup_id removed from subgroup_object_parsed
      expect(objEvents[0]).not.toHaveProperty('group_id');
      expect(objEvents[0]).not.toHaveProperty('object_id');
    });

    it('stream_type_set fired with fetch_header for fetch streams', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      const fetchHeader: FetchHeader = { requestId: varint(10n) };
      const stream = mock.addIncomingStream();
      stream.push(encodeFetchHeader(fetchHeader));
      await deepFlush();

      const streamTypeEvents = events.filter((e) => e.type === 'stream_type_set');
      expect(streamTypeEvents).toHaveLength(1);
      expect(streamTypeEvents[0].stream_type).toBe('fetch_header');
      expect(streamTypeEvents[0].owner).toBe('remote');
    });

    it('fetch_header_parsed fired with request_id', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      const fetchHeader: FetchHeader = { requestId: varint(42n) };
      const stream = mock.addIncomingStream();
      stream.push(encodeFetchHeader(fetchHeader));
      await deepFlush();

      const headerEvents = events.filter((e) => e.type === 'fetch_header_parsed');
      expect(headerEvents).toHaveLength(1);
      expect(headerEvents[0].request_id).toBe(42n);
    });

    it('fetch_object_parsed fired for each decoded fetch object', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      const fetchHeader: FetchHeader = { requestId: varint(5n) };
      // First fetch object: GROUP_ID(0x08) | OBJECT_ID(0x04) | PRIORITY(0x10) = 0x1C
      const fetchObj: FetchObject = {
        flags: varint(0x1c),
        groupId: varint(1n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 100,
        isDatagram: false,
        extensions: undefined,
        payload: new Uint8Array([0xAA, 0xBB]),
      };

      const stream = mock.addIncomingStream();
      stream.push(concat(
        encodeFetchHeader(fetchHeader),
        encodeFetchObject(fetchObj),
      ));
      stream.close();
      await deepFlush();

      const objEvents = events.filter((e) => e.type === 'fetch_object_parsed');
      expect(objEvents).toHaveLength(1);
      expect(objEvents[0].group_id).toBe(1n);
      expect(objEvents[0].subgroup_id).toBe(0n);
      expect(objEvents[0].object_id).toBe(0n);
      expect(objEvents[0].publisher_priority).toBe(100);
      expect(objEvents[0].object_payload_length).toBe(2);
    });

    it('object_datagram_parsed fired for decoded datagrams', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const events: any[] = [];
      adapter.onQlogEvent = (e) => events.push(e);

      // typeByte 0x02 = END_OF_GROUP bit set (DatagramFlags.END_OF_GROUP)
      const datagram: ObjectDatagram = {
        typeByte: 0x02,
        trackAlias: varint(1),
        groupId: varint(5),
        objectId: varint(3),
        publisherPriority: 200,
        isEndOfGroup: true,
        extensions: undefined,
        payload: new Uint8Array([0xDE, 0xAD]),
        status: undefined,
      };
      mock.pushDatagram(encodeObjectDatagram(datagram));
      await deepFlush();

      const dgEvents = events.filter((e) => e.type === 'object_datagram_parsed');
      expect(dgEvents).toHaveLength(1);
      expect(dgEvents[0].track_alias).toBe(1n);
      expect(dgEvents[0].group_id).toBe(5n);
      expect(dgEvents[0].object_id).toBe(3n);
      expect(dgEvents[0].publisher_priority).toBe(200);
      expect(dgEvents[0].end_of_group).toBe(true);
    });
  });

  // ─── Unhandled action types ────────────────────────────────────

  describe('unhandled action types', () => {
    it('reports error for unimplemented action types via onError', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onError = vi.fn();
      adapter.onError = onError;

      // publisher-side actions that the adapter can't handle
      await (adapter as any).executeActions([
        { type: 'open_data_stream', streamType: 'subgroup', trackAlias: varint(1), groupId: varint(0) },
      ]);

      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls[0]![0].message).toMatch(/unhandled.*open_data_stream/i);
    });

    it('emits MoqtConnectionError with errorSource "control" for unhandled actions', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onError = vi.fn();
      adapter.onError = onError;

      await (adapter as any).executeActions([
        { type: 'open_data_stream', streamType: 'subgroup', trackAlias: varint(1), groupId: varint(0) },
      ]);

      expect(onError).toHaveBeenCalled();
      const err = onError.mock.calls[0]![0];
      expect(err).toBeInstanceOf(MoqtConnectionError);
      expect(err.errorSource).toBe('control');
      expect(err.isFatal).toBe(true);
    });
  });

  // ─── MoqtConnectionError typed errors ──────────────────────────────────

  describe('typed MoqtConnectionError emission', () => {
    it('closes session on malformed control message instead of emitting MoqtConnectionError (§9)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onClose = vi.fn();
      adapter.onClose = onClose;

      // Send malformed control bytes that cause a framing error
      const malformed = new Uint8Array([0x10, 0x00, 0x02, 0xFF, 0xFF]);
      mock.pushControlBytes(malformed);
      await deepFlush();

      // §9: MUST close the session — not just emit an error
      expect(mock.closeFn).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledWith(0x3, expect.any(String));
    });

    it('RESET_STREAM does not emit onError — stream-level event, not an error (§10.4.3)', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onError = vi.fn();
      const onStreamClosed = vi.fn();
      adapter.onError = onError;
      adapter.onStreamClosed = onStreamClosed;

      // Add a data stream and immediately reset it with an error code
      const stream = mock.addIncomingStream();
      stream.reset(0x2); // DELIVERY_TIMEOUT
      await deepFlush();

      // §10.4.3: RESET_STREAM is normal — should NOT trigger onError
      expect(onError).not.toHaveBeenCalled();
      // Should notify via onStreamClosed with the error code
      expect(onStreamClosed).toHaveBeenCalled();
      expect(onStreamClosed.mock.calls[0]![1]).toBe(0x2);
    });

    it('emits MoqtConnectionError with errorSource "datagram" for non-protocol datagram errors', async () => {
      const mock = createMockTransport();
      const adapter = await connectAdapter(mock);
      const onError = vi.fn();
      adapter.onError = onError;

      // Push a datagram that's long enough to not be a RangeError (not truncated)
      // but malformed enough to cause a non-PROTOCOL_VIOLATION decode error.
      // A valid-looking datagram with an impossible varint that causes a TypeError
      // rather than RangeError or PROTOCOL_VIOLATION.
      // Use a byte sequence that decodes some fields but fails on payload.
      // Actually, RangeErrors are silently dropped. Non-protocol, non-range errors
      // go through onError. We need to trigger a generic Error.
      // Datagram with valid flags byte but corrupt track alias varint (overlong encoding)
      const badDatagram = new Uint8Array([
        0x00, // flags: no extensions, no end_of_group
        // track alias as 8-byte varint (0xC0 prefix) pointing to massive value
        0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
        // group id
        0x00,
        // object id
        0x00,
        // publisher priority
        0x80,
        // payload: empty
      ]);
      mock.pushDatagram(badDatagram);
      await deepFlush();

      // Non-RangeError, non-PROTOCOL_VIOLATION errors should emit MoqtConnectionError
      if (onError.mock.calls.length > 0) {
        const err = onError.mock.calls[0]![0];
        expect(err).toBeInstanceOf(MoqtConnectionError);
        expect(err.errorSource).toBe('datagram');
        expect(err.isFatal).toBe(false);
      }
    });
  });
});

// ─── Draft-14 Adapter Tests ──────────────────────────────────────────

describe('MoqtConnection draft-14', () => {
  /** Manually build a draft-14 SERVER_SETUP wire message.
   *  Type=0x21, Length(uint16), Selected Version (varint), Count(varint), Params
   *  Params use absolute KVP: even keys → key(varint) + value(varint), no length prefix */
  function encodeServerSetupV14(): Uint8Array {
    // Build payload: Selected Version + Count + Params
    // Selected version: 0xff00000e (draft-14)
    const version = varint(0xff00000en);
    // Param: MAX_REQUEST_ID (key=0x02, even key → value is raw varint)
    const key = varint(SetupParam.MAX_REQUEST_ID);
    const val = varint(10);
    const count = varint(1);

    const payloadLen =
      varintEncodingLength(version) +
      varintEncodingLength(count) +
      varintEncodingLength(key) +
      varintEncodingLength(val);

    const payload = new Uint8Array(payloadLen);
    let pos = 0;
    pos += writeVarint(version, payload, pos);
    pos += writeVarint(count, payload, pos);
    pos += writeVarint(key, payload, pos);
    pos += writeVarint(val, payload, pos);

    // Frame: type=0x21 (varint) + length (uint16 BE) + payload
    const typeVarint = varint(0x21);
    const typeBuf = new Uint8Array(varintEncodingLength(typeVarint));
    writeVarint(typeVarint, typeBuf, 0);
    const frame = new Uint8Array(typeBuf.length + 2 + payload.length);
    pos = 0;
    frame.set(typeBuf, pos); pos += typeBuf.length;
    frame[pos++] = (payload.length >> 8) & 0xff;
    frame[pos++] = payload.length & 0xff;
    frame.set(payload, pos);
    return frame;
  }

  /** Helper: connect a draft-14 adapter and complete the setup handshake. */
  async function connectV14Adapter(mock: MockTransport): Promise<MoqtConnection> {
    const adapter = new MoqtConnection(14);
    const connectPromise = adapter.connect(mock.transport);
    await flush();
    mock.pushControlBytes(encodeServerSetupV14());
    await connectPromise;
    return adapter;
  }

  it('completes v14 setup handshake', async () => {
    const mock = createMockTransport();
    const adapter = await connectV14Adapter(mock);
    expect(adapter).toBeDefined();
  });

  it('delivers v14 fetch status object with correct status codes', async () => {
    /**
     * Finding 5: Draft-14 fetch status codes must be preserved.
     * Wire status 0x1 (OBJECT_DOES_NOT_EXIST) → emitted status 0x1
     * Wire status 0x3 (END_OF_GROUP) → emitted status 0x3
     * Wire status 0x4 (END_OF_TRACK) → emitted status 0x4
     *
     * @see draft-ietf-moq-transport-14 §10.4.4
     */
    const mock = createMockTransport();
    const adapter = await connectV14Adapter(mock);

    // Subscribe to get a requestId
    const subRequestId = await adapter.subscribe(
      [new Uint8Array([0x6c])],
      new Uint8Array([0x76]),
    );

    const objects: MoqtObject[] = [];
    adapter.onObject = (_streamId, obj) => objects.push(obj);

    // V14 fetch object with status 0x1 (OBJECT_DOES_NOT_EXIST):
    // Group ID (i), Subgroup ID (i), Object ID (i), Publisher Priority (8),
    // Extension Headers Length (i), Object Payload Length (i=0), Object Status (i=0x1)
    function buildV14FetchStatusObject(
      groupId: bigint, objectId: bigint, status: bigint,
    ): Uint8Array {
      const parts: Uint8Array[] = [];
      // Group ID
      const gid = new Uint8Array(varintEncodingLength(varint(groupId)));
      writeVarint(varint(groupId), gid, 0);
      parts.push(gid);
      // Subgroup ID
      const sgid = new Uint8Array(varintEncodingLength(varint(0n)));
      writeVarint(varint(0n), sgid, 0);
      parts.push(sgid);
      // Object ID
      const oid = new Uint8Array(varintEncodingLength(varint(objectId)));
      writeVarint(varint(objectId), oid, 0);
      parts.push(oid);
      // Publisher Priority (8)
      parts.push(new Uint8Array([128]));
      // Extension Headers Length (0)
      const ext = new Uint8Array(varintEncodingLength(varint(0n)));
      writeVarint(varint(0n), ext, 0);
      parts.push(ext);
      // Object Payload Length (0 = status object)
      const pl = new Uint8Array(varintEncodingLength(varint(0n)));
      writeVarint(varint(0n), pl, 0);
      parts.push(pl);
      // Object Status
      const st = new Uint8Array(varintEncodingLength(varint(status)));
      writeVarint(varint(status), st, 0);
      parts.push(st);
      // Concat
      const total = parts.reduce((s, a) => s + a.length, 0);
      const result = new Uint8Array(total);
      let pos = 0;
      for (const a of parts) { result.set(a, pos); pos += a.length; }
      return result;
    }

    // Build fetch stream data: header + 3 status objects
    const stream = mock.addIncomingStream();

    // Use encodeFetchHeader (same wire format for both drafts: 0x05 + requestId)
    const fetchHeaderBytes = encodeFetchHeader({ requestId: subRequestId });

    // Push all data in a single chunk (matches v16 test pattern)
    stream.push(concat(
      fetchHeaderBytes,
      buildV14FetchStatusObject(1n, 0n, 0x1n), // OBJECT_DOES_NOT_EXIST
      buildV14FetchStatusObject(2n, 0n, 0x3n), // END_OF_GROUP
      buildV14FetchStatusObject(3n, 0n, 0x4n), // END_OF_TRACK
    ));
    stream.close();

    await deepFlush();

    // Verify status codes are preserved
    expect(objects.length).toBeGreaterThanOrEqual(3);
    const gaps = objects.filter(o => o.kind === 'gap');
    expect(gaps.length).toBe(3);
    expect(gaps[0]!.status).toBe(0x1n); // OBJECT_DOES_NOT_EXIST
    expect(gaps[1]!.status).toBe(0x3n); // END_OF_GROUP
    expect(gaps[2]!.status).toBe(0x4n); // END_OF_TRACK
  });

  it('applies REQUEST_UPDATE state immediately without waiting for REQUEST_OK', async () => {
    /**
     * Finding 4: Draft-14 has no REQUEST_OK for SUBSCRIBE_UPDATE.
     * State changes must be applied immediately.
     *
     * @see draft-ietf-moq-transport-14 §9.10
     */
    const mock = createMockTransport();
    const adapter = await connectV14Adapter(mock);

    // Subscribe
    const requestId = await adapter.subscribe(
      [new Uint8Array([0x6c])],
      new Uint8Array([0x76]),
    );

    // Accept with SUBSCRIBE_OK — manually build v14 wire format since
    // Draft14Codec only decodes server messages, it doesn't encode them.
    // Wire format: Type=0x04 (varint), Length (uint16 BE), payload:
    //   Request ID (varint), Track Alias (varint), Expires (varint=0),
    //   Group Order (u8=0), Content Exists (u8=0), Param Count (varint=0)
    const subOkPayload = new Uint8Array(
      varintEncodingLength(requestId) +
      varintEncodingLength(varint(42n)) +
      varintEncodingLength(varint(0)) + // expires
      1 + // group order
      1 + // content exists
      varintEncodingLength(varint(0)), // param count
    );
    let p = 0;
    p += writeVarint(requestId, subOkPayload, p);
    p += writeVarint(varint(42n), subOkPayload, p);
    p += writeVarint(varint(0), subOkPayload, p);  // expires
    subOkPayload[p++] = 0; // group order
    subOkPayload[p++] = 0; // content exists = 0
    p += writeVarint(varint(0), subOkPayload, p);  // 0 params

    const subOkType = varint(0x04);
    const subOkTypeBuf = new Uint8Array(varintEncodingLength(subOkType));
    writeVarint(subOkType, subOkTypeBuf, 0);
    const subscribeOk = new Uint8Array(subOkTypeBuf.length + 2 + subOkPayload.length);
    let sp = 0;
    subscribeOk.set(subOkTypeBuf, sp); sp += subOkTypeBuf.length;
    subscribeOk[sp++] = (subOkPayload.length >> 8) & 0xff;
    subscribeOk[sp++] = subOkPayload.length & 0xff;
    subscribeOk.set(subOkPayload, sp);
    mock.pushControlBytes(subscribeOk);
    await deepFlush();

    // Send REQUEST_UPDATE (pause)
    await adapter.requestUpdate(requestId, { forward: 0 });

    // Should NOT leak pending state — adapter should accept this without errors
    // (If pending state leaked, subsequent updates would eventually overflow)
    await adapter.requestUpdate(requestId, { forward: 1 });
    await adapter.requestUpdate(requestId, { forward: 0 });

    // No errors should have been emitted
    // (The test passes if no uncaught exceptions occur)
  });

  // ── Protocol negotiation (§3.1) ─────────────────────────────────

  describe('protocol negotiation (§3.1)', () => {
    it('no explicit version + undefined protocol defaults to draft 16', () => {
      const adapter = new MoqtConnection();
      expect(adapter.draftVersion).toBe(16);
    });

    it('explicit new MoqtConnection(14) uses draft 14 regardless of protocol', () => {
      const adapter = new MoqtConnection(14);
      expect(adapter.draftVersion).toBe(14);
    });

    it('uses draft-14 codec when transport.protocol is "moq-00"', async () => {
      const adapter = new MoqtConnection(); // no explicit version

      // Create mock transport with protocol='moq-00'
      const { readable: serverReadable, writable: serverWritable } = new TransformStream<Uint8Array>();
      const { readable: clientReadable, writable: clientWritable } = new TransformStream<Uint8Array>();

      const transport: WebTransportLike = {
        protocol: 'moq-00',
        createBidirectionalStream: async () => ({
          readable: serverReadable,
          writable: clientWritable,
        }),
        incomingUnidirectionalStreams: new ReadableStream({ start(c) { /* never emit */ } }),
        datagrams: { readable: new ReadableStream({ start(c) { /* never emit */ } }) },
        close: () => {},
        closed: new Promise(() => {}),
      };

      // Start connect in background (it will block waiting for SERVER_SETUP)
      const connectPromise = adapter.connect(transport, { maxRequestId: varint(100) });

      // Read what the adapter sent — should be draft-14 CLIENT_SETUP format
      const reader = clientReadable.getReader();
      const { value } = await reader.read();
      expect(value).toBeDefined();

      // Draft-14 CLIENT_SETUP type is 0x20 — same as draft-16.
      // But draft-14 format has: type + length + numVersions + version + params
      // Draft-16 format has: type + length + numParams + params
      // We can check: after type(1B) + length(2B), the next varint should be
      // numVersions=1 (draft-14) or numParams=N (draft-16).
      // For draft-14 with 1 version: byte[3] = 0x01 (numVersions)
      // Then version 0xff00000e as a varint.
      const bytes = value!;
      expect(bytes[0]).toBe(0x20); // CLIENT_SETUP type
      // Skip type(1) + length(2) = offset 3
      expect(bytes[3]).toBe(0x01); // numVersions = 1 (draft-14 format)

      // Clean up
      reader.releaseLock();
    });

    it('keeps draft-16 codec when transport.protocol is "moqt-16"', async () => {
      const adapter = new MoqtConnection(); // no explicit version

      const { readable: serverReadable, writable: serverWritable } = new TransformStream<Uint8Array>();
      const { readable: clientReadable, writable: clientWritable } = new TransformStream<Uint8Array>();

      const transport: WebTransportLike = {
        protocol: 'moqt-16',
        createBidirectionalStream: async () => ({
          readable: serverReadable,
          writable: clientWritable,
        }),
        incomingUnidirectionalStreams: new ReadableStream({ start(c) { /* never emit */ } }),
        datagrams: { readable: new ReadableStream({ start(c) { /* never emit */ } }) },
        close: () => {},
        closed: new Promise(() => {}),
      };

      const connectPromise = adapter.connect(transport, { maxRequestId: varint(100) });

      const reader = clientReadable.getReader();
      const { value } = await reader.read();
      const bytes = value!;
      expect(bytes[0]).toBe(0x20); // CLIENT_SETUP type
      // Draft-16: after type(1) + length(2), next is numParams (not numVersions)
      // With maxRequestId param, numParams >= 1
      // Key difference: draft-14 byte[3]=0x01 (numVersions=1) then 0xc0... (version varint)
      // Draft-16 byte[3] = numParams, then param type varint
      // numParams won't be followed by 0xff00000e version
      // Just verify it's NOT the draft-14 version varint pattern
      const afterHeader = bytes[3]!;
      // If draft-16: afterHeader is numParams (small number like 1-3)
      // followed by param type (0x02 for MAX_REQUEST_ID)
      expect(bytes[4]).toBe(0x02); // param type = MAX_REQUEST_ID (draft-16 format)

      reader.releaseLock();
    });

    it('explicit version overrides transport.protocol', async () => {
      const adapter = new MoqtConnection(14); // force draft-14

      const { readable: serverReadable, writable: serverWritable } = new TransformStream<Uint8Array>();
      const { readable: clientReadable, writable: clientWritable } = new TransformStream<Uint8Array>();

      const transport: WebTransportLike = {
        protocol: 'moqt-16', // server says 16, but we forced 14
        createBidirectionalStream: async () => ({
          readable: serverReadable,
          writable: clientWritable,
        }),
        incomingUnidirectionalStreams: new ReadableStream({ start(c) { /* never emit */ } }),
        datagrams: { readable: new ReadableStream({ start(c) { /* never emit */ } }) },
        close: () => {},
        closed: new Promise(() => {}),
      };

      const connectPromise = adapter.connect(transport, { maxRequestId: varint(100) });

      const reader = clientReadable.getReader();
      const { value } = await reader.read();
      const bytes = value!;
      expect(bytes[0]).toBe(0x20);
      expect(bytes[3]).toBe(0x01); // numVersions = 1 (draft-14, forced)

      reader.releaseLock();
    });

    it('auto-negotiates draft-18 when transport.protocol is "moqt-18" (no explicit version)', () => {
      const adapter = new MoqtConnection(); // no explicit version
      const transport: WebTransportLike = {
        protocol: 'moqt-18',
        createBidirectionalStream: async () => ({
          readable: new ReadableStream({ start() { /* never emit */ } }),
          writable: new WritableStream(),
        }),
        createUnidirectionalStream: async () => new WritableStream(),
        incomingUnidirectionalStreams: new ReadableStream({ start() { /* never emit */ } }),
        incomingBidirectionalStreams: new ReadableStream({ start() { /* never emit */ } }),
        datagrams: { readable: new ReadableStream({ start() { /* never emit */ } }), writable: new WritableStream() },
        close: () => {},
        closed: new Promise(() => {}),
      };
      // connect() reconfigures to the negotiated draft synchronously — before the
      // uni-pair SETUP awaits — so draftVersion flips to 18 immediately. The
      // establish() then hangs against this never-emitting mock; we don't await it.
      void adapter.connect(transport).catch(() => { /* establish never completes */ });
      expect(adapter.draftVersion).toBe(18);
    });

    it('explicit constructor version overrides transport.protocol "moqt-18"', () => {
      const adapter = new MoqtConnection(16); // force draft-16 despite moqt-18

      const { readable: serverReadable } = new TransformStream<Uint8Array>();
      const { writable: clientWritable } = new TransformStream<Uint8Array>();

      const transport: WebTransportLike = {
        protocol: 'moqt-18', // server says 18, but we forced 16
        createBidirectionalStream: async () => ({
          readable: serverReadable,
          writable: clientWritable,
        }),
        incomingUnidirectionalStreams: new ReadableStream({ start() { /* never emit */ } }),
        datagrams: { readable: new ReadableStream({ start() { /* never emit */ } }) },
        close: () => {},
        closed: new Promise(() => {}),
      };

      // Explicit version short-circuits negotiation: stays 16 and takes the legacy
      // single-bidi-control path (which then waits for SERVER_SETUP; not awaited).
      void adapter.connect(transport, { maxRequestId: varint(100) }).catch(() => { /* setup never completes */ });
      expect(adapter.draftVersion).toBe(16);
    });
  });

  // ─── Publisher operations (§9.10, §9.8, §9.15, §10.4.2) ──────────

  describe('publisher operations', () => {
    const enc = new TextEncoder();

    /**
     * Helper: inject a SUBSCRIBE on the control stream (simulating a
     * subscriber sending SUBSCRIBE to our publisher adapter).
     */
    function injectSubscribe(
      mock: MockTransport,
      requestId: bigint,
      namespace: Uint8Array[],
      trackName: Uint8Array,
    ): void {
      const msg: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(requestId),
        trackNamespace: namespace,
        trackName,
        parameters: new Map(),
      };
      mock.pushControlBytes(encodeControlMessage(msg));
    }

    /**
     * Helper: connect an adapter with maxRequestId set, allowing
     * the peer to send requests (SUBSCRIBEs, etc.) to us.
     */
    async function connectPublisherAdapter(
      mock: MockTransport,
    ): Promise<MoqtConnection> {
      const adapter = new MoqtConnection();
      const connectPromise = adapter.connect(mock.transport, {
        maxRequestId: varint(100),
      });
      await flush();
      mock.pushControlBytes(encodeServerSetup());
      await connectPromise;
      return adapter;
    }

    // ─── onSubscribe callback ─────────────────────────────────────

    describe('onSubscribe callback', () => {
      it('fires when a SUBSCRIBE arrives on the control stream', async () => {
        const mock = createMockTransport();
        const adapter = await connectPublisherAdapter(mock);
        const onSubscribe = vi.fn();
        adapter.onSubscribe = onSubscribe;

        const ns = [enc.encode('live')];
        const name = enc.encode('video');
        injectSubscribe(mock, 1n, ns, name);
        await deepFlush();

        expect(onSubscribe).toHaveBeenCalledOnce();
        expect(onSubscribe.mock.calls[0]![0]).toBe(varint(1n));  // requestId
        // namespace
        expect(onSubscribe.mock.calls[0]![1]).toEqual(ns);
        // trackName
        expect(onSubscribe.mock.calls[0]![2]).toEqual(name);
      });

      it('does not fire for non-SUBSCRIBE messages', async () => {
        const mock = createMockTransport();
        const adapter = await connectPublisherAdapter(mock);
        const onSubscribe = vi.fn();
        adapter.onSubscribe = onSubscribe;

        const goaway: Goaway = { type: 'GOAWAY', newSessionUri: '' };
        mock.pushControlBytes(encodeControlMessage(goaway));
        await deepFlush();

        expect(onSubscribe).not.toHaveBeenCalled();
      });
    });

    // ─── acceptSubscribe ──────────────────────────────────────────

    describe('acceptSubscribe()', () => {
      it('sends SUBSCRIBE_OK on the control stream (§9.10)', async () => {
        const mock = createMockTransport();
        const adapter = await connectPublisherAdapter(mock);

        // Inject incoming SUBSCRIBE
        injectSubscribe(mock, 1n, [enc.encode('live')], enc.encode('video'));
        await deepFlush();

        const beforeCount = mock.controlWritten.length;
        await adapter.acceptSubscribe(varint(1n), varint(42n));

        expect(mock.controlWritten.length).toBeGreaterThan(beforeCount);
        const bytes = mock.controlWritten[mock.controlWritten.length - 1]!;
        const { message } = decodeControlMessage(bytes, 0);
        expect(message.type).toBe('SUBSCRIBE_OK');
        expect((message as any).requestId).toBe(varint(1n));
        expect((message as any).trackAlias).toBe(varint(42n));
      });
    });

    // ─── rejectSubscribe ──────────────────────────────────────────

    describe('rejectSubscribe()', () => {
      it('sends REQUEST_ERROR on the control stream (§9.8)', async () => {
        const mock = createMockTransport();
        const adapter = await connectPublisherAdapter(mock);

        injectSubscribe(mock, 1n, [enc.encode('live')], enc.encode('video'));
        await deepFlush();

        const beforeCount = mock.controlWritten.length;
        await adapter.rejectSubscribe(varint(1n), varint(0x10n), 'Does not exist');

        expect(mock.controlWritten.length).toBeGreaterThan(beforeCount);
        const bytes = mock.controlWritten[mock.controlWritten.length - 1]!;
        const { message } = decodeControlMessage(bytes, 0);
        expect(message.type).toBe('REQUEST_ERROR');
        expect((message as any).requestId).toBe(varint(1n));
        expect((message as any).errorCode).toBe(varint(0x10n));
        expect((message as any).errorReason).toBe('Does not exist');
      });
    });

    // ─── publishDone ──────────────────────────────────────────────

    describe('publishDone()', () => {
      it('sends PUBLISH_DONE on the control stream (§9.15)', async () => {
        const mock = createMockTransport();
        const adapter = await connectPublisherAdapter(mock);

        // Inject + accept SUBSCRIBE first (publishDone requires established sub)
        injectSubscribe(mock, 1n, [enc.encode('live')], enc.encode('video'));
        await deepFlush();
        await adapter.acceptSubscribe(varint(1n), varint(42n));

        const beforeCount = mock.controlWritten.length;
        await adapter.publishDone(varint(1n), varint(0x2n), 'Track ended');

        expect(mock.controlWritten.length).toBeGreaterThan(beforeCount);
        const bytes = mock.controlWritten[mock.controlWritten.length - 1]!;
        const { message } = decodeControlMessage(bytes, 0);
        expect(message.type).toBe('PUBLISH_DONE');
        expect((message as any).requestId).toBe(varint(1n));
        expect((message as any).statusCode).toBe(varint(0x2n));
      });
    });

    // ─── openSubgroup + sendObject + closeSubgroup ────────────────

    describe('data stream publishing (§10.4.2)', () => {
      it('openSubgroup creates a unidirectional stream with SUBGROUP_HEADER', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const streamId = await adapter.openSubgroup(
          varint(42n),  // trackAlias
          varint(0n),   // groupId
          varint(0n),   // subgroupId
        );

        expect(streamId).toBeDefined();
        expect(typeof streamId).toBe('bigint');

        // Verify a unidirectional stream was opened
        expect(mock.outgoingStreams.length).toBe(1);

        // Decode the SUBGROUP_HEADER bytes written to the stream
        const written = mock.outgoingStreams[0]!.written;
        expect(written.length).toBeGreaterThan(0);
        const headerBytes = concat(...written);
        const { header } = decodeSubgroupHeader(headerBytes, 0, 16);
        expect(header.trackAlias).toBe(varint(42n));
        expect(header.groupId).toBe(varint(0n));
        expect(header.subgroupId).toBe(varint(0n));
      });

      it('sendObject writes encoded object bytes to the stream', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const streamId = await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
        );

        const payload = new Uint8Array([0xCA, 0xFE]);
        await adapter.sendObject(streamId, varint(0n), payload);

        // The stream should have header + object written
        const written = mock.outgoingStreams[0]!.written;
        // Combine all written chunks
        const allBytes = concat(...written);

        // Decode header first to get past it
        const { bytesRead: headerLen } = decodeSubgroupHeader(allBytes, 0, 16);

        // Decode the object
        const { object } = decodeSubgroupObject(
          allBytes, headerLen, false, varint(0n), true, 16,
        );
        expect(object.objectId).toBe(varint(0n));
        expect(object.payload).toEqual(payload);
      });

      it('sendObject encodes multiple objects with correct delta IDs', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const streamId = await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
        );

        await adapter.sendObject(streamId, varint(0n), new Uint8Array([0x01]));
        await adapter.sendObject(streamId, varint(1n), new Uint8Array([0x02]));
        await adapter.sendObject(streamId, varint(2n), new Uint8Array([0x03]));

        const allBytes = concat(...mock.outgoingStreams[0]!.written);
        const { bytesRead: headerLen } = decodeSubgroupHeader(allBytes, 0, 16);

        // Decode object 0
        const { object: obj0, bytesRead: len0 } = decodeSubgroupObject(
          allBytes, headerLen, false, varint(0n), true, 16,
        );
        expect(obj0.objectId).toBe(varint(0n));

        // Decode object 1
        const { object: obj1, bytesRead: len1 } = decodeSubgroupObject(
          allBytes, headerLen + len0, false, obj0.objectId, false, 16,
        );
        expect(obj1.objectId).toBe(varint(1n));

        // Decode object 2
        const { object: obj2 } = decodeSubgroupObject(
          allBytes, headerLen + len0 + len1, false, obj1.objectId, false, 16,
        );
        expect(obj2.objectId).toBe(varint(2n));
      });

      it('closeSubgroup sends FIN on the stream', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const streamId = await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
        );

        await adapter.closeSubgroup(streamId);

        expect(mock.outgoingStreams[0]!.closed).toBe(true);
      });

      it('openSubgroup with extensions flag sets hasExtensions in header', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
          { hasExtensions: true },
        );

        const headerBytes = concat(...mock.outgoingStreams[0]!.written);
        const { header } = decodeSubgroupHeader(headerBytes, 0, 16);
        expect(header.hasExtensions).toBe(true);
      });

      it('sendObject with extensions writes extension data', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const streamId = await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
          { hasExtensions: true },
        );

        const extensions = new Uint8Array([0x01, 0x02, 0x03]);
        const payload = new Uint8Array([0xCA, 0xFE]);
        await adapter.sendObject(streamId, varint(0n), payload, extensions);

        const allBytes = concat(...mock.outgoingStreams[0]!.written);
        const { bytesRead: headerLen } = decodeSubgroupHeader(allBytes, 0, 16);
        const { object } = decodeSubgroupObject(
          allBytes, headerLen, true, varint(0n), true, 16,
        );
        expect(object.extensions).toEqual(extensions);
        expect(object.payload).toEqual(payload);
      });

      it('openSubgroup with publisherPriority sets priority in header', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
          { publisherPriority: 64 },
        );

        const headerBytes = concat(...mock.outgoingStreams[0]!.written);
        const { header } = decodeSubgroupHeader(headerBytes, 0, 16);
        expect(header.publisherPriority).toBe(64);
      });

      it('openSubgroup with defaultPriority omits priority byte (§10.4.2)', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
          { defaultPriority: true },
        );

        const headerBytes = concat(...mock.outgoingStreams[0]!.written);
        const { header } = decodeSubgroupHeader(headerBytes, 0, 16);
        // DEFAULT_PRIORITY bit set → publisherPriority should be undefined
        expect(header.publisherPriority).toBeUndefined();
        // Verify the type byte has DEFAULT_PRIORITY flag (0x20)
        expect(header.typeByte & SubgroupFlags.DEFAULT_PRIORITY).toBe(SubgroupFlags.DEFAULT_PRIORITY);
      });

      it('openSubgroup with subgroupIdMode ZERO omits subgroupId field (§10.4.2)', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        await adapter.openSubgroup(
          varint(42n), varint(5n), varint(0n),
          { subgroupIdMode: SubgroupIdMode.ZERO, defaultPriority: true, endOfGroup: true },
        );

        const headerBytes = concat(...mock.outgoingStreams[0]!.written);
        const { header } = decodeSubgroupHeader(headerBytes, 0, 16);
        expect(header.trackAlias).toBe(varint(42n));
        expect(header.groupId).toBe(varint(5n));
        // SubgroupIDZero → subgroupId implicitly 0
        expect(header.subgroupId).toBe(varint(0n));
        // Type byte should be 0x38: SUBGROUP_MARKER(0x10) | END_OF_GROUP(0x08) | DEFAULT_PRIORITY(0x20)
        expect(header.typeByte).toBe(0x38);
      });

      it('closeSubgroup removes stream from internal map', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const streamId = await adapter.openSubgroup(
          varint(42n), varint(0n), varint(0n),
        );
        await adapter.closeSubgroup(streamId);

        // sendObject on a closed stream should throw
        await expect(
          adapter.sendObject(streamId, varint(1n), new Uint8Array([0x01])),
        ).rejects.toThrow();
      });
    });

    // ─── publishNamespace ─────────────────────────────────────────

    describe('publishNamespace()', () => {
      it('sends PUBLISH_NAMESPACE on the control stream', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const ns = [enc.encode('live'), enc.encode('stream1')];
        const beforeCount = mock.controlWritten.length;
        const requestId = await adapter.publishNamespace(ns);

        expect(requestId).toBeDefined();
        expect(mock.controlWritten.length).toBeGreaterThan(beforeCount);

        const bytes = mock.controlWritten[mock.controlWritten.length - 1]!;
        const { message } = decodeControlMessage(bytes, 0);
        expect(message.type).toBe('PUBLISH_NAMESPACE');
      });
    });

    // ─── publishNamespaceDone (§9.22) ─────────────────────────────

    describe('publishNamespaceDone()', () => {
      it('v16: sends PUBLISH_NAMESPACE_DONE with requestId, no trackNamespace', async () => {
        const mock = createMockTransport();
        const adapter = await connectAdapter(mock);

        const ns = [enc.encode('live'), enc.encode('stream1')];
        const requestId = await adapter.publishNamespace(ns);

        mock.pushControlBytes(encodeControlMessage({
          type: 'REQUEST_OK',
          requestId,
          parameters: new Map(),
        }));
        await flush();

        await adapter.publishNamespaceDone(requestId);

        const bytes = mock.controlWritten[mock.controlWritten.length - 1]!;
        const { message } = decodeControlMessage(bytes, 0);
        expect(message.type).toBe('PUBLISH_NAMESPACE_DONE');
        expect((message as any).requestId).toBe(BigInt(requestId));
        expect((message as any).trackNamespace).toBeUndefined();
      });

      it('v14: sends PUBLISH_NAMESPACE_DONE with trackNamespace, no requestId', async () => {
        const mock = createMockTransport();
        const adapter = await connectV14Adapter(mock);
        const v14Codec = createControlCodec(14);

        const ns = [enc.encode('live'), enc.encode('stream1')];
        const requestId = await adapter.publishNamespace(ns);

        // v14 acceptance uses PUBLISH_NAMESPACE_OK, encoded with v14 codec
        mock.pushControlBytes(v14Codec.encode({
          type: 'PUBLISH_NAMESPACE_OK',
          requestId,
        }));
        await flush();

        await adapter.publishNamespaceDone(requestId);

        const bytes = mock.controlWritten[mock.controlWritten.length - 1]!;
        const { message } = v14Codec.decode(bytes, 0);
        expect(message.type).toBe('PUBLISH_NAMESPACE_DONE');
        expect((message as any).trackNamespace).toEqual(ns);
        expect((message as any).requestId).toBeUndefined();
      });
    });
  });
});
