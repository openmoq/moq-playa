import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { vi } from 'vitest';
import { buildCatalogSelection, PlayerErrorCode, usesMsePath } from '@openmoq/player';
import type { PlayerError, MediaSelectionSnapshot } from '@openmoq/player';
import { TeardownBarrier, parseVideoAltGroup, waitForOutput } from './view-selection.js';
import { playbackOwnerIsCurrent, selectionMenus } from './selection-controls.js';

const file = new URL('./main.ts', import.meta.url);
const source = ts.createSourceFile('main.ts', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set([
  'startPlayback',
  'startPlaybackAttempt',
  'stopPlayback',
  'prefetchCatalogViaFetch',
  'reconnect',
  'withTimeout',
  'noteMediaArrival',
  'toggleStopPlay'
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
  || ts.isExpressionStatement(n) && n.getText(source).startsWith("startBtn.addEventListener('click'")
);
const code = ts.transpileModule(nodes.map(n => n.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

export const refusal: PlayerError = {
  severity: 'fatal',
  source: 'catalog',
  code: PlayerErrorCode.SUBSCRIPTION_REFUSED,
  message: 'Catalog subscription refused: unroutable (code=0x10)',
  timestampMs: 0
};

export const connectionFailure: PlayerError = {
  severity: 'fatal',
  source: 'connection',
  code: PlayerErrorCode.CONNECTION_LOST,
  message: 'connection lost',
  timestampMs: 0
};

export const wedged: PlayerError = {
  severity: 'fatal',
  source: 'decoder',
  code: PlayerErrorCode.MEDIA_ELEMENT_WEDGED,
  message: 'media element wedged',
  timestampMs: 0
};

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return {
    promise,
    resolve,
    reject
  };
}

export async function flush() {
  for (let i = 0; i < 32; i++)
    await Promise.resolve();
}

export function fixture(configure?: (p: FakePlayer, index: number) => void) {
  const instances: FakePlayer[] = [], renderers: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [], logs: string[] = [];
  class Player extends FakePlayer {
    constructor() {
      super();
      instances.push(this);
      configure?.(this, instances.length);
    }
  }
  const startListeners: Array<(event: { stopPropagation(): void }) => void> = [];
  const consoleError = vi.fn();
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
    console: { error: consoleError },
    startBtn: { addEventListener(type: string, listener: (event: { stopPropagation(): void }) => void) {
      if (type === 'click') startListeners.push(listener);
    } },
    pauseBtn: { disabled: false },
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
    log: (message: string) => logs.push(message),
    namespaceArg: 'live',
    authority: undefined,
    warmStart: false,
    catalogFromUrl: undefined,
    catalogBootstrap: 'subscribe',
    certHash: undefined,
    draftVersion: 18,
    CanvasRenderer: class {
      readonly start = vi.fn();
      readonly stop = vi.fn();
      constructor() {
        renderers.push(this);
      }
    },
    canvas: { style: {} },
    renderer: null,
    startupSummaryEnabled: false,
    trace: null,
    createWebTransport: () => async () => ({}),
    MoqtConnection: class {
    },
    MoqtPlayer: Player,
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
    viewRetuner: { busy: false },
    setControlIcon() {},
    flashCenter() {},
    showPlayerControls() {},
    hideTimer: null,
    parseVideoAltGroup,
    loadingSpinner: { style: { display: 'none' } },
    controls: { style: { display: 'none' } },
    centerPlay: { style: { display: '' } }
  });
  runInContext(code, context);
  return {
    context,
    instances,
    renderers,
    logs,
    consoleError,
    clickStart() {
      for (const listener of startListeners) listener({ stopPropagation() {} });
    },
    async close() {
      await context.stopPlayback();
    }
  };
}

export class FakePlayer {
  state = 'loading';
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly selection: MediaSelectionSnapshot = {
    revision: 0,
    scope: null,
    video: null,
    audio: null,
    videoAlternatives: [],
    audioChoices: [],
    autoQuality: true
  };
  readonly load = vi.fn(async () => {});
  readonly play = vi.fn(() => {
    this.state = 'playing';
  });
  readonly destroy = vi.fn(async () => {
    this.state = 'destroyed';
  });
  on(name: string, callback: (event: unknown) => void) {
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }
  emit(error: PlayerError) {
    if (error.severity === 'fatal')
      this.state = 'error';
    for (const f of this.listeners.get('error') ?? [])
      f({ type: 'error', error });
  }
}
