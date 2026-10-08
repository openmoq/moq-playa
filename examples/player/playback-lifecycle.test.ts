import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeardownBarrier, parseVideoAltGroup } from './view-selection.js';
import { createWebTransport } from '@openmoq/browser';

// Run the demo's actual lifecycle with DOM and network boundaries replaced.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['startPlayback', 'startPlaybackAttempt', 'stopPlayback', 'prefetchCatalogViaFetch', 'waitForOutput']);
const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.has(n.name?.text ?? ''))
  .map(n => n.getText(source)).join('\n');
const code = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(fetchCatalog = false) {
  const closes = vi.fn();
  const instances: FakePlayer[] = [];
  let fetches = 0;
  let holdReady = false;
  let holdDestroy: Promise<void> | undefined;
  let holdConnect: Promise<void> | undefined;
  const nativeCloses = vi.fn();
  const context = createContext({
    AbortController, TextEncoder, TextDecoder, URLSearchParams, AggregateError, setTimeout, clearTimeout,
    params: new URLSearchParams(fetchCatalog ? 'fetchCatalog=1' : ''), selectedVideoAltGroup: undefined,
    playEpoch: 0, startupDiscovery: null, startupTransport: null, teardownBarrier: new TeardownBarrier(100),
    ensureAudio: () => ({ ctx: {}, clock: {} }), newStartupLatch: () => ({}),
    resolveRelayEndpoint: async () => 'https://test.invalid', log: vi.fn(),
    namespaceArg: 'live', authority: undefined, warmStart: false, catalogFromUrl: undefined, catalogBootstrap: undefined,
    certHash: undefined, draftVersion: undefined, CanvasRenderer: class { stop() {} start() {} },
    canvas: {}, renderer: null, startupSummaryEnabled: false, trace: null,
    createWebTransport: ({ signal }: { signal: AbortSignal }) => async () => {
      if (!holdReady) return {};
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { nativeCloses(); reject(signal.reason); }, { once: true });
      });
    },
    MoqtConnection: class {
      async connect() { await holdConnect; } async fetch() { fetches++; return 1n; } async close() { closes(); }
    },
    varint: (v: unknown) => v, CATALOG_TRACK_NAME: 'catalog',
    videoEl: { pause() {} }, lastMediaMs: 0, healthySinceMs: 0, cmafActive: false,
    player: null, externalConnection: null, mediaSourceRef: null, window: {}, isPlaying: false,
    setControlIcon() {}, flashCenter() {}, showPlayerControls() {}, hideTimer: null, parseVideoAltGroup,
    loadingSpinner: { style: {} }, controls: { style: {} },
  });
  class FakePlayer {
    constructor(readonly options: { createTransport(url: string): Promise<unknown> }) { instances.push(this); }
    on() { return () => {}; }
    async load() { await this.options.createTransport('https://test.invalid'); }
    play() {}
    async destroy() { await holdDestroy; }
  }
  context.MoqtPlayer = FakePlayer;
  runInContext(code, context);
  return { context, closes, nativeCloses, instances, fetches: () => fetches,
    holdReady: () => { holdReady = true; }, holdDestroy: (p: Promise<void>) => { holdDestroy = p; },
    holdConnect: (p: Promise<void>) => { holdConnect = p; } };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('demo player teardown ownership', () => {
  it('reclaims a ready transport delivered after Stop without opening a connection', async () => {
    const f = fixture(true);
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn();
    const connect = vi.fn(async () => {});
    vi.stubGlobal('WebTransport', class {
      ready = ready;
      closed = new Promise(() => {});
      protocol = 'moqt-16';
      close = close;
    });
    f.context.createWebTransport = createWebTransport;
    f.context.MoqtConnection = class { connect = connect; async close() { close(); } };
    const started = expect(f.context.startPlayback()).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(f.context.startupTransport).not.toBeNull());
    // The factory releases its abort listener before its caller resumes.
    ready.then(() => queueMicrotask(() => { void f.context.stopPlayback(true); }));
    release();
    await started;
    expect(close).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(f.context.externalConnection).toBeNull();
  });
  it('closes a preflight waiting for catalog when startup is cancelled', async () => {
    const f = fixture(true);
    const controller = new AbortController();
    const started = f.context.startPlayback(controller.signal);
    const rejected = expect(started).rejects.toThrow('cancel');
    await vi.waitFor(() => expect(f.fetches()).toBe(1));
    controller.abort(new Error('cancel'));
    await rejected;
    expect(f.closes).toHaveBeenCalledTimes(1);
    expect(f.context.externalConnection).toBeNull();
  });
  it('closes a failed preflight and clears its timeout', async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    const rejected = expect(f.context.startPlayback()).rejects.toThrow('FETCH catalog timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(f.closes).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels an unsettled preflight handshake without sending a late FETCH', async () => {
    const f = fixture(true);
    let release!: () => void;
    f.holdConnect(new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const started = expect(f.context.startPlayback(controller.signal)).rejects.toThrow('cancel');
    await vi.waitFor(() => expect(f.context.externalConnection).not.toBeNull());
    controller.abort(new Error('cancel'));
    await started;
    expect(f.closes).toHaveBeenCalledTimes(1);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.fetches()).toBe(0);
  });
  it('bounds the entire preflight including a handshake that never settles', async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    f.holdConnect(new Promise(() => {}));
    const started = expect(f.context.startPlayback()).rejects.toThrow('FETCH catalog timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await started;
    expect(f.closes).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels native readiness during FETCH preflight without opening a connection', async () => {
    const f = fixture(true);
    f.holdReady();
    const controller = new AbortController();
    const started = expect(f.context.startPlayback(controller.signal)).rejects.toThrow('cancel');
    await vi.waitFor(() => expect(f.context.startupTransport).not.toBeNull());
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(new Error('cancel'));
    await started;
    expect(f.nativeCloses).toHaveBeenCalledTimes(1);
    expect(f.fetches()).toBe(0);
  });
  it('retains the factory cancellation owner after startup for pending migration', async () => {
    const f = fixture();
    await f.context.startPlayback();
    f.holdReady();
    const candidate = expect(f.instances[0]!.options.createTransport('https://migration.invalid')).rejects.toThrow('stopped');
    await f.context.stopPlayback(true);
    await candidate;
    expect(f.nativeCloses).toHaveBeenCalledTimes(1);
  });
  it('does not start a successor after teardown timeout until the old player releases its sink', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.context.startPlayback();
    let release!: () => void;
    f.holdDestroy(new Promise<void>(resolve => { release = resolve; }));
    const stopped = expect(f.context.stopPlayback(true)).rejects.toThrow('teardown timed out');
    await vi.advanceTimersByTimeAsync(100);
    await stopped;
    const started = expect(f.context.startPlayback()).rejects.toThrow('teardown timed out');
    await vi.advanceTimersByTimeAsync(100);
    await started;
    expect(f.instances).toHaveLength(1);
    release();
    await f.context.teardownBarrier.wait();
    await f.context.startPlayback();
    expect(f.instances).toHaveLength(2);
  });
});
