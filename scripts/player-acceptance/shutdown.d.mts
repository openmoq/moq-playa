import type { ChildProcess } from 'node:child_process';
export interface ProcessState {
  child: ChildProcess;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  failure: string | null;
  done: Promise<number | null>;
  stopRequested?: boolean;
}
export function stopProcess(state: ProcessState): Promise<void>;
