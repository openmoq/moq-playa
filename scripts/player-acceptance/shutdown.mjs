function signal(state, signalName) {
  if (state.exited) return;
  try {
    if (process.platform === 'win32') state.child.kill(signalName);
    else process.kill(-state.child.pid, signalName);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function stopProcess(state) {
  if (!state.exited) state.stopRequested = true;
  signal(state, 'SIGTERM');
  let timer;
  try {
    await Promise.race([state.done, new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
    if (!state.exited) {
      signal(state, 'SIGKILL');
      let killTimer;
      try {
        await Promise.race([state.done, new Promise((_, reject) => {
          killTimer = setTimeout(() => reject(new Error('Killed child did not exit within 3000ms')), 3000);
        })]);
      } finally { clearTimeout(killTimer); }
      throw new Error('Child process required SIGKILL');
    }
    if (state.exitCode === 0 && state.failure === null) return;
    if (state.stopRequested && state.exitCode === null && state.exitSignal === 'SIGTERM') return;
    // pnpm/tsx may encode requested SIGTERM as 128 + 15 instead of a signal.
    if (state.stopRequested && state.exitCode === 143 && state.exitSignal === null && state.failure === null) return;
    throw new Error(`Child process failed: exit=${state.exitCode} signal=${state.exitSignal} ${state.failure ?? ''}`);
  } finally { clearTimeout(timer); }
}
