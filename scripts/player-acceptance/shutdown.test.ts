import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stopProcess, type ProcessState } from './shutdown.mjs';

async function child(code: string): Promise<ProcessState> {
  const process = spawn(globalThis.process.execPath, ['-e', `${code};console.log('ready');setInterval(()=>{},1000)`], {
    detached: globalThis.process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state: ProcessState = { child: process, exited: false, exitCode: null, exitSignal: null, failure: null,
    done: new Promise((resolve) => process.once('close', (exitCode, exitSignal) => {
      state.exited = true; state.exitCode = exitCode; state.exitSignal = exitSignal; resolve(exitCode);
    })),
  };
  await once(process.stdout!, 'data');
  return state;
}

describe('acceptance process shutdown', () => {
  it('accepts an orderly zero exit', async () => {
    await expect(stopProcess(await child("process.on('SIGTERM',()=>process.exit(0))"))).resolves.toBeUndefined();
  });
  it('accepts its requested SIGTERM and remains idempotent', async () => {
    const state = await child('');
    await expect(stopProcess(state)).resolves.toBeUndefined();
    await expect(stopProcess(state)).resolves.toBeUndefined();
  });
  it('rejects a shutdown handler that exits nonzero', async () => {
    await expect(stopProcess(await child("process.on('SIGTERM',()=>process.exit(1))")))
      .rejects.toThrow(/exit=1/);
  });
  it('accepts the requested SIGTERM encoded by a process wrapper as exit 143', async () => {
    const state = await child("process.on('SIGTERM',()=>process.exit(143))");
    await expect(stopProcess(state)).resolves.toBeUndefined();
    await expect(stopProcess(state)).resolves.toBeUndefined();
  });
  it('rejects exit 143 when termination was not requested by the harness', async () => {
    const state = await child("process.on('SIGTERM',()=>process.exit(143))");
    state.child.kill('SIGTERM'); await state.done;
    await expect(stopProcess(state)).rejects.toThrow(/exit=143/);
  });
  it('rejects an earlier process failure', async () => {
    const state = await child('');
    state.child.kill('SIGKILL');
    await state.done;
    await expect(stopProcess(state)).rejects.toThrow(/SIGKILL/);
  });
  it('rejects and reaps a child that ignores termination', async () => {
    const state = await child("process.on('SIGTERM',()=>{})");
    await expect(stopProcess(state)).rejects.toThrow(/SIGKILL/);
    expect(state.exited).toBe(true);
  }, 7000);
});
