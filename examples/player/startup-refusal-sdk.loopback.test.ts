import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { MoqtPlayer, PlayerErrorCode, buildCatalogSelection, usesMsePath } from '@openmoq/player';
import type { MoqtPlayerConfig } from '@openmoq/player';
import { MoqtConnection } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../packages/webtransport/src/testkit/loopback.js';
import { TeardownBarrier, parseVideoAltGroup, waitForOutput } from './view-selection.js';
import { playbackOwnerIsCurrent, selectionMenus } from './selection-controls.js';
const body = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('main.ts', body, ts.ScriptTarget.Latest, true);
const names = new Set([
  'startPlayback',
  'startPlaybackAttempt',
  'stopPlayback',
  'prefetchCatalogViaFetch',
  'reconnect',
  'withTimeout',
  'noteMediaArrival'
]);
const constants = new Set([
  'LIVENESS_TIMEOUT_MS',
  'HEALTHY_RESET_MS',
  'RECONNECT_BACKOFF_MS',
  'MAX_RECONNECT_ATTEMPTS',
  'START_ATTEMPT_TIMEOUT_MS'
]);
const nodes = source.statements.filter(
  n => ts.isClassDeclaration(n) && n.name?.text === 'PlaybackStartFailure'
  || ts.isFunctionDeclaration(n) && names.has(n.name?.text ?? '')
  || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && constants.has(d.name.text))
  || ts.isExpressionStatement(n) && n.getText(source).startsWith('setInterval(') && n.getText(source).includes('No media for')
);
const code = ts.transpileModule(nodes.map(n => n.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(acceptWatch = false) {
  const namespaceRequests: Array<{ server: MoqtConnection; id: bigint }> = [];
  const peers: Array<{
    client: MoqtConnection;
    server: MoqtConnection;
    a: ReturnType<typeof createLoopback>['a'];
    requests: Array<{
      id: bigint;
      name: string;
    }>;
  }> = [];
  const players: MoqtPlayer[] = [], logs: string[] = [];
  class ExamplePlayer extends MoqtPlayer {
    constructor(config: MoqtPlayerConfig) {
      const { a, b } = createLoopback(), client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' }), requests: Array<{
        id: bigint;
        name: string;
      }> = [];
      server.onSubscribe = (id, _ns, name) => {
        requests.push({ id, name: new TextDecoder().decode(name) });
      };
      server.onSubscribeNamespace = id => {
        namespaceRequests.push({ server, id });
        if (acceptWatch) void server.acceptSubscribeNamespace(id);
        else void server.rejectSubscribeNamespace(id, 1n, 'discovery unavailable');
      };
      super({
        ...config,
        createConnection: () => client,
        createTransport: async () => {
          void server.connect(b).catch(() => {});
          return a;
        }
      });
      peers.push({
        client,
        server,
        a,
        requests
      });
      players.push(this);
    }
  }
  const context = createContext({
    AbortController,
    TextEncoder,
    TextDecoder,
    URLSearchParams,
    AggregateError,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
    console,
    params: new URLSearchParams(),
    selectedPresentation: undefined,
    selectedAudioLanguage: undefined,
    catalogSelection: null,
    pendingVideoSelection: null,
    selectionStatus: { textContent: '' },
    refreshTrackSelector() {},
    buildTrackSelector() {},
    buildCatalogSelection,
    playbackOwnerIsCurrent,
    selectionMenus,
    waitForOutput,
    playEpoch: 0,
    startupDiscovery: null,
    startupTransport: null,
    teardownBarrier: new TeardownBarrier(100),
    ensureAudio: () => ({ ctx: {}, clock: { now: () => performance.now() * 1000 } }),
    newStartupLatch: () => ({}),
    resolveRelayEndpoint: async () => 'https://test.invalid',
    log: (x: string) => logs.push(x),
    namespaceArg: 'live',
    msfLink: undefined,
    msfRefusal: undefined,
    authority: undefined,
    warmStart: false,
    catalogFromUrl: undefined,
    catalogBootstrap: 'subscribe',
    certHash: undefined,
    draftVersion: 18,
    CanvasRenderer: class {
      start() {}
      stop() {}
    },
    canvas: { style: {} },
    renderer: null,
    startupSummaryEnabled: false,
    trace: null,
    createWebTransport: () => async () => ({}),
    MoqtConnection,
    MoqtPlayer: ExamplePlayer,
    PlayerErrorCode,
    usesMsePath,
    videoEl: { pause() {}, style: {} },
    lastMediaMs: 0,
    healthySinceMs: 0,
    cmafActive: false,
    player: null,
    externalConnection: null,
    mediaSourceRef: null,
    window: {},
    isPlaying: false,
    transitioning: false,
    reconnecting: false,
    reconnectCancelled: false,
    retryCount: 0,
    setControlIcon() {},
    flashCenter() {},
    showPlayerControls() {},
    hideTimer: null,
    parseVideoAltGroup,
    loadingSpinner: { style: {} },
    controls: { style: {} },
    centerPlay: { style: {} }
  });
  runInContext(code, context);
  return {
    context,
    namespaceRequests,
    peers,
    players,
    logs,
    async close() {
      await context.stopPlayback();
      for (const p of peers) {
        await p.client.close();
        await p.server.close();
      }
    }
  };
}
beforeEach(() => vi.useFakeTimers({ toFake: [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'performance',
  'Date'
  ] }));
afterEach(() => vi.useRealTimers());
describe('actual example lifecycle with real core and SDK, no DOM/media implementation', () => {
  it('fatal/catalog refusal before first media must not strand the example in playing with disarmed recovery', async () => {
    const f = fixture();
    try {
      await f.context.startPlayback();
      await flush(128);
      expect(f.context.isPlaying).toBe(true);
      expect(f.peers).toHaveLength(1);
      const states: string[] = [];
      f.players[0]!.on('state_changed', e => {
        states.push(e.to);
      });
      const h = f.peers[0]!;
      expect(h.requests).toHaveLength(1);
      await h.server.rejectSubscribe(h.requests[0]!.id, 0x10n, 'unroutable');
      await flush(256);
      expect(states).toContain('error');
      expect(f.logs.some(x => x.includes('fatal/catalog'))).toBe(true);
      expect(f.context.lastMediaMs).toBe(0);
      await vi.advanceTimersByTimeAsync(120000);
      await flush(128);
      expect(f.peers).toHaveLength(1);
      // This oracle requires truthful failed startup/UI state, not violation of Retry Interval 0 by blind polling.
      expect(f.context.isPlaying).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('CONTROL: the same actual example reconnects a fatal connection failure before first media', async () => {
    const f = fixture();
    try {
      await f.context.startPlayback();
      await flush(128);
      expect(f.context.lastMediaMs).toBe(0);
      f.peers[0]!.a.failClosed(new Error('relay closed'));
      await flush(256);
      await vi.advanceTimersByTimeAsync(1001);
      await flush(256);
      expect(f.peers).toHaveLength(2);
      expect(f.logs.some(x => x.includes('Reconnected.'))).toBe(true);
    } finally {
      await f.close();
    }
  });
});


it('reconnects, waits without polling, and re-subscribes when the relay announces the publisher', async () => {
  const f = fixture(true);
  try {
    await f.context.startPlayback(); await flush(128);
    f.peers[0]!.a.failClosed(new Error('relay closed')); await flush(256);
    await vi.advanceTimersByTimeAsync(1001); await flush(256);
    expect(f.peers).toHaveLength(2);
    const h = f.peers[1]!, catalogs = () => h.requests.filter(r => r.name === 'catalog');
    expect(catalogs()).toHaveLength(1);
    await h.server.rejectSubscribe(catalogs()[0]!.id, 0x10n, 'unroutable'); await flush(256);
    await vi.advanceTimersByTimeAsync(3000); await flush(128);
    expect(f.peers.slice(1).flatMap(p => p.requests.filter(r => r.name === 'catalog'))).toHaveLength(1);
    for (const watch of f.namespaceRequests.filter(w => w.server === h.server)) {
      await h.server.sendNamespace(watch.id, []);
    }
    await flush(256);
    expect(catalogs()).toHaveLength(2); expect(f.context.isPlaying).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); await flush(128);
    expect(catalogs()).toHaveLength(2); expect(f.peers).toHaveLength(2);
  } finally { await f.close(); }
});


it('abandons a hung replacement tune-in at 15000 ms', async () => {
  const f = fixture();
  try {
    await f.context.startPlayback(); await flush(128);
    f.context.startPlayback = () => new Promise(() => {});
    f.peers[0]!.a.failClosed(new Error('relay closed')); await flush(256);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(14999);
    expect(f.logs.some(line => line.includes('tune-in timed out'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await flush(128);
    expect(f.logs.some(line => line.includes('tune-in timed out after 15000ms'))).toBe(true);
  } finally { await f.close(); }
});
