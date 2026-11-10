import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { PlaybackSample } from './assessment.mjs';
import type { AudioObservationWindow } from './net-shape.mjs';

function observer(errorOnDestroy: boolean, webAudio = false) {
  let now = 1000;
  let interval: (() => void) | undefined;
  let period: number | undefined;
  let start: (() => void) | undefined;
  const analyser = { frequencyBinCount: 2, fftSize: 4,
    getFloatTimeDomainData(values: Float32Array) { values.fill(0.1); },
    getFloatFrequencyData(values: Float32Array) { values.fill(-100); }, disconnect() {} };
  const context = { sampleRate: 48000, currentTime: 0, state: 'running' };
  class Player {
    state = 'idle';
    readonly stats = { videoPlaybackQuality: null };
    handlers = new Map<string, (data: unknown) => void>();
    on(type: string, callback: (data: unknown) => void) { this.handlers.set(type, callback); }
    async load() {}
    play() { this.state = 'playing'; }
    async destroy() {
      if (errorOnDestroy) this.handlers.get('error')?.({ message: 'teardown failed' });
    }
  }
  const handlers = new Map<string, () => void>();
  const video = {
    addEventListener: (type: string, callback: () => void) => { handlers.set(type, callback); },
    requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {}, getAttribute: () => null,
    currentTime: 0, paused: true, readyState: 0, buffered: { length: 0 },
  };
  const source = readFileSync(new URL('../../examples/_tests/player-acceptance/main.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const window: { playerAcceptance?: { begin(silent: boolean, minimumDurationMs?: number): void;
    finish(): { samples: PlaybackSample[]; audioObservation: AudioObservationWindow | null; events: unknown[]; nativeEvents: { type: string }[] };
    destroy(): Promise<{ events: { type: string }[] }> } } = {};
  runInNewContext(compiled, {
    exports: {}, window, URLSearchParams, Uint8Array, Float32Array,
    performance: { now: () => now },
    clearInterval: () => { interval = undefined; },
    setInterval: (callback: () => void, ms: number) => { interval = callback; period = ms; return 1; },
    location: { search: `?hash=${'00'.repeat(32)}&url=https://local&ns=test${webAudio ? '&audio=webcodecs' : ''}` },
    require: (name: string) => name === '@openmoq/playa' ? { Player }
      : { createWebTransport: () => () => {}, observeAudio: () => ({ restore() {}, taps: [{ context, analyser }] }) },
    document: {
      querySelector: (selector: string) => selector === '#video' ? video : {
        addEventListener: (_type: string, callback: () => void) => { if (selector === '#start') start = callback; },
      },
      createElement: () => ({ getContext: () => ({ drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(64 * 36 * 4) }) }) }),
    },
  });
  return { state: window.playerAcceptance!, fire: (type: string) => handlers.get(type)?.(),
    async start() { start?.(); await Promise.resolve(); await Promise.resolve(); },
    advance(ms: number) { now += ms; interval?.(); },
    get period() { return period; },
  };
}

describe('browser observer terminal events', () => {
  it('includes a player error emitted during destroy in terminal evidence', async () => {
    const { state } = observer(true);
    expect(state.finish().events).toEqual([]);
    const result = await state.destroy();
    expect(result.events.map((event) => event.type)).toContain('error');
  });
  it('preserves an error-free teardown', async () => {
    expect((await observer(false).state.destroy()).events).toEqual([]);
  });
  it('records every native error/wait/stall only during the recording window', () => {
    const { state, fire } = observer(false, true);
    const types = ['error', 'waiting', 'stalled'];
    types.forEach(fire);
    expect(state.finish().nativeEvents).toEqual([]);
    state.begin(false);
    types.forEach(fire);
    types.forEach(fire);
    expect(state.finish().nativeEvents.map(event => event.type)).toEqual([...types, ...types]);
    types.forEach(fire);
    expect(state.finish().nativeEvents).toHaveLength(6);
    state.begin(false);
    expect(state.finish().nativeEvents).toEqual([]);
  });
});

describe('audio observation clock ownership', () => {
  it('captures the requested window on the sample clock without trimming its start', async () => {
    const f = observer(false, true); await f.start();
    f.state.begin(false, 5000);
    for (let i = 0; i < 20; i++) f.advance(250);
    const result = f.state.finish();
    expect(result.samples).toHaveLength(21);
    expect(result.samples[0]?.wallMs).toBe(1000);
    expect(result.audioObservation).toEqual({ startMs: 1000, endMs: 6000, minimumDurationMs: 5000, samplePeriodMs: f.period });
  });

  it('keeps the requested duration when recording ends early and copies terminal evidence', async () => {
    const f = observer(false, true); await f.start();
    f.state.begin(false, 5000); f.advance(250);
    const first = f.state.finish();
    expect(first.audioObservation).toEqual({ startMs: 1000, endMs: 1250, minimumDurationMs: 5000, samplePeriodMs: 250 });
    f.advance(1000);
    expect(f.state.finish().audioObservation).toEqual(first.audioObservation);
    if (first.audioObservation) first.audioObservation.startMs = 9999;
    first.samples.length = 0;
    expect(f.state.finish().audioObservation?.startMs).toBe(1000);
    expect(f.state.finish().samples).toHaveLength(2);
    f.state.begin(false, 250); f.advance(250);
    expect(f.state.finish().audioObservation).toEqual({ startMs: 2250, endMs: 2500, minimumDurationMs: 250, samplePeriodMs: 250 });
  });

  it('does not certify an undeclared window and refuses overlapping recordings', async () => {
    const f = observer(false, true); await f.start();
    f.state.begin(false);
    expect(() => f.state.begin(false, 5000)).toThrow(/recording/i);
    expect(f.state.finish().audioObservation).toBeNull();
    expect(() => f.state.begin(false, Infinity)).toThrow(/duration/i);
  });
});
