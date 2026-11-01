import type { PlaybackInputObserver, PlaybackInputDiscardReason } from './types.js';

/** One observation assignment. Keys follow actual admitted jitter-buffer entries. */
export class PipelineInputs {
  private readonly entries = new Map<string, object>();
  private refused = 0;
  get lossCount(): number { return this.refused; }
  constructor(readonly observer: PlaybackInputObserver, private readonly live: () => boolean) {}
  remember(key: string, input: object | undefined): void {
    if (!input || !this.live()) return;
    // The application may configure a much larger media buffer. Observation
    // keeps its own fixed bound and never evicts already admitted ownership.
    if (this.entries.size >= 1024) {
      if (this.refused < Number.MAX_SAFE_INTEGER) this.refused++;
      return;
    }
    this.entries.set(key, input);
  }
  take(key: string): object | undefined { const input = this.entries.get(key); this.entries.delete(key); return input; }
  clear(): object[] { const inputs = [...this.entries.values()]; this.entries.clear(); return inputs; }
  report(input: object | undefined, reason: PlaybackInputDiscardReason): void {
    if (!input || !this.live()) return;
    try { const pending = this.observer(input, reason); if (pending) void Promise.resolve(pending).catch(() => {}); }
    catch { /* Input metadata cannot alter decode policy or another entry. */ }
  }
  reportAll(inputs: readonly object[] | undefined, reason: PlaybackInputDiscardReason): void {
    if (inputs) for (const input of inputs) this.report(input, reason);
  }
}
