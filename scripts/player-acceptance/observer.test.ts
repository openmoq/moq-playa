import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function observer(errorOnDestroy: boolean) {
  class Player {
    state = 'idle';
    handlers = new Map<string, (data: unknown) => void>();
    on(type: string, callback: (data: unknown) => void) { this.handlers.set(type, callback); }
    async destroy() {
      if (errorOnDestroy) this.handlers.get('error')?.({ message: 'teardown failed' });
    }
  }
  const video = { requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {}, getAttribute: () => null };
  const source = readFileSync(new URL('../../examples/_tests/player-acceptance/main.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const window: { playerAcceptance?: { finish(): { events: unknown[] }; destroy(): Promise<{ events: { type: string }[] }> } } = {};
  runInNewContext(compiled, {
    exports: {}, window, URLSearchParams, Uint8Array, performance, clearInterval,
    location: { search: `?hash=${'00'.repeat(32)}&url=https://local&ns=test` },
    require: (name: string) => name === '@openmoq/playa' ? { Player } : { createWebTransport: () => () => {} },
    document: {
      querySelector: (selector: string) => selector === '#video' ? video : { addEventListener: () => {} },
      createElement: () => ({ getContext: () => ({}) }),
    },
  });
  return window.playerAcceptance!;
}

describe('browser observer terminal events', () => {
  it('includes a player error emitted during destroy in terminal evidence', async () => {
    const state = observer(true);
    expect(state.finish().events).toEqual([]);
    const result = await state.destroy();
    expect(result.events.map((event) => event.type)).toContain('error');
  });
  it('preserves an error-free teardown', async () => {
    expect((await observer(false).destroy()).events).toEqual([]);
  });
});
