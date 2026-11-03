import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function observer(errorOnDestroy: boolean, webAudio = false) {
  class Player {
    state = 'idle';
    readonly stats = { videoPlaybackQuality: null };
    handlers = new Map<string, (data: unknown) => void>();
    on(type: string, callback: (data: unknown) => void) { this.handlers.set(type, callback); }
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
  const window: { playerAcceptance?: { begin(silent: boolean): void; finish(): { events: unknown[]; nativeEvents: { type: string }[] };
    destroy(): Promise<{ events: { type: string }[] }> } } = {};
  runInNewContext(compiled, {
    exports: {}, window, URLSearchParams, Uint8Array, performance, clearInterval, setInterval: () => 0,
    location: { search: `?hash=${'00'.repeat(32)}&url=https://local&ns=test${webAudio ? '&audio=webcodecs' : ''}` },
    require: (name: string) => name === '@openmoq/playa' ? { Player }
      : { createWebTransport: () => () => {}, observeAudio: () => ({ restore() {} }) },
    document: {
      querySelector: (selector: string) => selector === '#video' ? video : { addEventListener: () => {} },
      createElement: () => ({ getContext: () => ({}) }),
    },
  });
  return { state: window.playerAcceptance!, fire: (type: string) => handlers.get(type)?.() };
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
