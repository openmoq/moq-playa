import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  closed: Promise.resolve() as Promise<void>,
  stop: vi.fn(),
}));

vi.mock('@fails-components/webtransport', () => ({
  quicheLoaded: Promise.resolve(),
  Http3Server: class {
    readonly ready = Promise.resolve();
    readonly closed = state.closed;
    startServer() {}
    stopServer = state.stop;
    address = () => ({ port: 4433 });
    sessionStream = () => new ReadableStream({ start(controller) { controller.close(); } });
  },
}));

vi.mock('./cert.js', () => ({ loadCert: () => ({ cert: '', privKey: '' }) }));

const { startServer } = await import('./server.js');

describe('node relay server shutdown', () => {
  beforeEach(() => {
    state.closed = Promise.resolve();
    state.stop.mockReset();
  });

  it('waits for backend closure and requests stop only once', async () => {
    let resolveClosed!: () => void;
    state.closed = new Promise((resolve) => { resolveClosed = resolve; });
    const server = await startServer();
    let settled = false;
    const first = Promise.resolve(server.stop()).then(() => { settled = true; });
    const second = server.stop();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(state.stop).toHaveBeenCalledOnce();
    resolveClosed();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
  });

  it('reports a synchronous backend stop failure', async () => {
    state.stop.mockImplementation(() => { throw new Error('backend stop failed'); });
    const server = await startServer();
    await expect(Promise.resolve().then(() => server.stop())).rejects.toThrow('backend stop failed');
  });

  it('reports a rejected backend closure', async () => {
    let rejectClosed!: (error: Error) => void;
    state.closed = new Promise((_, reject) => { rejectClosed = reject; });
    const server = await startServer();
    const stopped = server.stop();
    const assertion = expect(stopped).rejects.toThrow('backend closure failed');
    rejectClosed(new Error('backend closure failed'));
    await assertion;
  });
});
