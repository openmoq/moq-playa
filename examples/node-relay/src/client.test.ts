import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ready: Promise.resolve() as Promise<void>,
  connect: Promise.resolve() as Promise<void>,
  closed: Promise.resolve() as Promise<void>,
  close: Promise.resolve() as Promise<void>,
  transports: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  connections: [] as Array<{
    onError: ((error: Error) => void) | undefined;
    onClose: ((code?: number, reason?: string) => void) | undefined;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@fails-components/webtransport', () => ({
  quicheLoaded: Promise.resolve(),
  WebTransport: class MockWebTransport {
    readonly ready = state.ready;
    readonly closed = state.closed;
    readonly protocol = 'moqt-18';
    readonly close = vi.fn();

    constructor() {
      state.transports.push(this);
    }
  },
}));

vi.mock('@openmoq/webtransport', () => ({
  MoqtConnection: class MockMoqtConnection {
    readonly session = { state: 'connecting' };
    readonly connect = vi.fn(() => state.connect);
    readonly close = vi.fn(() => state.close);
    onError: ((error: Error) => void) | undefined;
    onClose: ((code?: number, reason?: string) => void) | undefined;
    onMessage: unknown;

    constructor() {
      state.connections.push(this);
    }
  },
}));

vi.mock('./cert.js', () => ({
  certSha256: () => new Uint8Array(32),
}));

vi.mock('./wt-adapter.js', () => ({
  nodeSessionToWebTransportLike: () => ({}),
}));

const { connectClient } = await import('./client.js');

function pending(): Promise<void> {
  return new Promise(() => undefined);
}

describe('node relay client setup cancellation', () => {
  beforeEach(() => {
    state.ready = Promise.resolve();
    state.connect = Promise.resolve();
    state.closed = Promise.resolve();
    state.close = Promise.resolve();
    state.transports.length = 0;
    state.connections.length = 0;
  });

  it('closes a transport whose WebTransport ready promise is pending', async () => {
    state.ready = pending();
    const controller = new AbortController();
    const result = connectClient('https://relay.example/moq', { signal: controller.signal });
    await vi.waitFor(() => expect(state.transports).toHaveLength(1));

    controller.abort();

    await expect(result).rejects.toThrow('WebTransport connection aborted');
    expect(state.transports[0]!.close).toHaveBeenCalledTimes(1);
    expect(state.connections).toHaveLength(0);
  });

  it('closes a transport whose MoQT setup is pending', async () => {
    state.connect = pending();
    const controller = new AbortController();
    const result = connectClient('https://relay.example/moq', { signal: controller.signal });
    await vi.waitFor(() => expect(state.connections).toHaveLength(1));

    controller.abort();

    await expect(result).rejects.toThrow('WebTransport connection aborted');
    expect(state.transports[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a session error after setup as a client failure', async () => {
    const handle = await connectClient('https://relay.example/moq');
    const failed = expect(handle.failure).rejects.toThrow('stream failed');

    state.connections[0]!.onError?.(new Error('stream failed'));

    await failed;
    await handle.close();
  });

  it('reports a rejected transport close instead of swallowing it', async () => {
    let rejectClosed!: (error: Error) => void;
    state.closed = new Promise((_, reject) => { rejectClosed = reject; });
    const handle = await connectClient('https://relay.example/moq');
    const closing = expect(handle.close()).rejects.toThrow();
    rejectClosed(new Error('transport shutdown failed'));
    await closing;
  });

  it('closes only once across concurrent callers and waits for the caller-held closed promise', async () => {
    let resolveClosed!: () => void;
    state.closed = new Promise((resolve) => { resolveClosed = resolve; });
    const handle = await connectClient('https://relay.example/moq');
    const first = handle.close();
    const second = handle.close();
    let settled = false;
    void first.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveClosed();
    await Promise.all([first, second, handle.transport.closed]);
    expect(state.connections[0]!.close).toHaveBeenCalledTimes(1);
    expect(state.transports[0]!.close).not.toHaveBeenCalled();
  });

  it('reports a rejected MoQT close', async () => {
    const handle = await connectClient('https://relay.example/moq');
    state.close = Promise.reject(new Error('MoQT shutdown failed'));
    await expect(handle.close()).rejects.toThrow();
  });

  it('surfaces an unexpected session close after setup as a client failure', async () => {
    const handle = await connectClient('https://relay.example/moq');
    const failed = expect(handle.failure).rejects.toThrow(
      'MoQT session closed unexpectedly (code=3, reason=protocol error)',
    );

    state.connections[0]!.onClose?.(3, 'protocol error');

    await failed;
    await handle.close();
  });
});
